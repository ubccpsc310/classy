import * as csvParse from 'csv-parse/lib/sync';
import * as fs from "fs-extra";

import Log, {LogLevel} from "../../../common/Log";
import Util from "../../../common/Util";

import {DatabaseController} from "../src/controllers/DatabaseController";
import {GradesController} from "../src/controllers/GradesController";
import {ResultsController} from "../src/controllers/ResultsController";

import {AuditLabel, Grade} from "../src/Types";

/**
 * To run this locally you need to have a .env configured with the production values
 * and a ssh tunnel configured to the server you want the database to come from.
 *
 * 1) Get on the VPN
 * 2) Make sure you don't have a local mongo instance running
 * 3) Ensure your .env corresponds to the production values; change DB_URL connection string to use 127.0.0.1
 *      * specifically, make sure DB_URL contains the mongo username and password
 * 4) ssh user@host -L 27017:127.0.0.1:27017
 * 5) Run this script: node packages/portal/backend/src-util/ReleaseC0.js
 */
export class ReleaseC0 {

    private dc: DatabaseController;

    /**
     * Whether the execution is for testing (true) or should actually change the database (false).
     *
     * @type {boolean}
     */
    private DRY_RUN = false;

    /**
     * A test user that can be used for checking DB writing (ignores DRY_RUN above, but only for this user).
     *
     * @type {string}
     */
    private readonly TEST_USER = 'XXXXX';

    /**
     * The delivId we are updating grades for.
     *
     * @type {string}
     */
    protected readonly DELIVID: string = 'c0';

    protected retroPath = `${__dirname}/c0retros.csv`;
    protected readonly retroScores: RetroScoreMap; // TODO should be in superclass

    private parserOptions = {
        columns:          true,
        skip_empty_lines: true,
        trim:             true
    };

    constructor() {
        Log.info("ReleaseC0::<init> - start");
        this.dc = DatabaseController.getInstance();
        this.retroScores = this.loadRetroScores();
    }

    private loadRetroScores(): RetroScoreMap {
        if (!fs.existsSync(this.retroPath)) {
            throw new Error("Retro score CSV does not exist");
        }
        const csvData = fs.readFileSync(this.retroPath).toString();
        const data = csvParse(csvData, this.parserOptions);
        const retroMap: RetroScoreMap = {};
        for (const record of data) {
            const cwl = record["Q2"].toLowerCase();
            const csid = record["Q8"].toLowerCase();
            const feedback = record["Q6"].toLowerCase();
            const score = 1;
            const entry = {feedback, score};
            retroMap[cwl] = entry;
            retroMap[csid] = entry;
        }
        return retroMap;
    }

    private applyRetroScore(grade: Grade): Grade {
        const retroEntry = this.retroScores[grade.personId];
        if (retroEntry === undefined) {
            Log.warn(`Retro missing for ${grade.personId}`);
        }
        const score = retroEntry?.score ?? 0;
        const feedback = retroEntry?.feedback ?? "";

        let retroComment = `Retrospective Score: ${score}`;
        if (feedback !== "") {
            retroComment += `; TA Feedback: ${feedback}`;
        }

        grade.comment = retroComment;
        grade.custom.retroScore = score;

        return grade;
    }

    public async process(): Promise<void> {
        Log.info("ReleaseC0::process() - start for delivId: " + this.DELIVID);

        const gradesC = new GradesController();
        const resultsC = new ResultsController();
        const dbc = DatabaseController.getInstance();

        // get all the DELIVID grade records eligible for updating
        const allGrades = await gradesC.getAllGrades();
        const grades = [];
        for (const grade of allGrades as Grade[]) {
            if (grade.delivId === this.DELIVID) {
                grades.push(grade);
            }
        }

        // should be one per student
        Log.info("ReleaseC0::process() - for: " + this.DELIVID + "; # grades: " + grades.length);

        const gradeDeltas: number[] = [];

        for (const grade of grades) {
            const url = grade.URL;

            const result = await resultsC.getResultFromURL(url, this.DELIVID);
            if (result !== null) {

                Log.info("Considering grade for " + this.DELIVID + " for url: " + url);

                // make sure row is valid
                if (typeof result.output === 'undefined' ||
                    typeof result.output.report === 'undefined' ||
                    typeof result.output.report.scoreTest === 'undefined' ||
                    typeof result.output.report.scoreOverall === 'undefined' ||
                    typeof result.output.report.custom === 'undefined'
                ) {
                    Log.error("FATAL: NO GRADE RECORD");
                    break;
                }

                let newGrade: Grade = JSON.parse(JSON.stringify(grade)); // Object.assign is a shallow copy which doesn't work here
                (newGrade.custom as any).publicGrade = grade; // keep the old grad record around in the grade.custom field
                newGrade.timestamp = Date.now(); // TS for when we updated the grade record

                // change grade
                // could add comment here too if needed (e.g., to newGrade.comment)
                newGrade.urlName = "Transformed";
                // newGrade.score = finalScore; TODO is this needed?

                newGrade = this.applyRetroScore(newGrade);

                Log.info("ReleaseC0::process() - processing result: " + url);
                if (this.DRY_RUN === false || grade.personId === this.TEST_USER) {
                    // publish grade
                    Log.info("Grade update for: " + newGrade.personId);
                    await gradesC.saveGrade(newGrade);
                    await dbc.writeAudit(AuditLabel.GRADE_CHANGE, 'ProcessPrivateTest', grade, newGrade, {});
                } else {
                    Log.info("Dry run grade update for: " + newGrade.personId);
                }
            } else {
                // should not really happen; if we have a grade already we must have a result
                Log.warn("ReleaseC0::process - WARN; no grade found for: " + url);
            }
        }

        Log.info("ReleaseC0::process() - done");
    }
}

interface RetroScoreMap {
    [id: string]: {feedback: string, score: number}
}

const ppt = new ReleaseC0();
const start = Date.now();
Log.Level = LogLevel.INFO;
ppt.process().then(function() {
    Log.info("ReleaseC0::process() - complete; took: " + Util.took(start));
    process.exit();
}).catch(function(err) {
    Log.error("ReleaseC0::process() - ERROR: " + err.message);
    process.exit();
});
