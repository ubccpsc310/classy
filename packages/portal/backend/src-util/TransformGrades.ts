import * as csvParse from 'csv-parse/lib/sync';
import * as fs from 'fs-extra';
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
 * 5) Run this script: node packages/portal/backend/src-util/AppendGradeComments.js
 */
export class TransformGrades {

    private dc: DatabaseController;

    // Grade multipliers for public and private test suites
    private PUB_TEST_COUNT = 42;
    private PRIV_TEST_COUNT = 20;
    private PUB_MULT = this.PUB_TEST_COUNT / (this.PUB_TEST_COUNT + this.PRIV_TEST_COUNT);
    private PRIV_MULT = this.PRIV_TEST_COUNT / (this.PUB_TEST_COUNT + this.PRIV_TEST_COUNT);

    private retroPath = `${__dirname}/c1retros.csv`;
    private retroScoreMap: {[student: string]: number} = {};

    private regressionPath = `${__dirname}/c1regressions.csv`;
    private regressionScoreMap: {[team: string]: number} = {};

    private parserOptions = {
        columns:          true,
        skip_empty_lines: true,
        trim:             true
    };

    /**
     * Whether the execution is for testing (true) or should actually change the database (false).
     *
     * @type {boolean}
     */
    private DRY_RUN = true;

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
    private readonly DELIVID: string = 'c1';

    constructor() {
        Log.info("AppendGradeComments::<init> - start");
        this.dc = DatabaseController.getInstance();
    }

    public loadRegressionScores() {
        const csvData = fs.readFileSync(this.regressionPath).toString();
        const data = csvParse(csvData, this.parserOptions);
        for (const record of data) {
            const name = record["Team"];
            const val = Number((record["Penalty"] * 100).toFixed(2));
            this.regressionScoreMap[name] = val;
        }
    }

    public applyRegressionScore(grade: Grade, repoId: string) {
        let regression = this.regressionScoreMap[repoId];
        regression = typeof regression !== "undefined" ? regression : 0;
        Log.info(`Applying regression score to ${grade.personId}. Would be ${regression}`);
        grade.custom.c1Regression = {
            preRegression: grade.score,
            penalty: regression,
            postRegression: grade.score - regression
        };
        if (grade.comment === undefined) {
            grade.comment = "";
        }
        if (regression > 0) {
            grade.comment += `A regression penalty of ${regression}% was applied to this grade.\n`;
        } else {
            grade.comment += `No regressions were applied to this grade.\n`;
        }
        grade.score -= regression;
        return grade;
    }

    public loadRetroScores() {
        const csvData = fs.readFileSync(this.retroPath).toString();
        const data = csvParse(csvData, this.parserOptions);
        for (const record of data) {
            const member1 = record["Q1.5"].toLowerCase();
            const member1Score = this.getScore(member1, record["Q2.9"]);
            const member2 = record["Q24"].toLowerCase();
            const member2Score = this.getScore(member2, record["Q35"]);
            const member3 = record["Q52"].toLowerCase();
            const member3Score = this.getScore(member3, record["Q47"]);
            this.retroScoreMap[member1] = member1Score;
            this.retroScoreMap[member2] = member2Score;
            this.retroScoreMap[member3] = member3Score;
        }
    }

    public applyRetroScores(grade: Grade) {
        const retro = this.retroScoreMap[grade.personId];
        const retroScore = typeof retro !== "undefined" ? retro : 1;
        Log.info(`Applying retro score to ${grade.personId}. Would be ${retroScore}`);
        grade.custom.c1Retro = retroScore;
        if (grade.comment === undefined) {
            grade.comment = "";
        }
        if (retroScore !== 1.0) {
            grade.comment += `Retrospective score: ${retroScore}. ` +
                `Note that retrospective scores will not be applied to grades until end of term\n`;
        } else {
            grade.comment += `Retrospective score: 1.0.\n`;
        }
        return grade;
    }

    private getScore(name: string, field: string) {
        try {
            return Number(field.split(" ")[0]);
        } catch (e) {
            if (name.length > 0) {
                Log.warn(`Parsing of score ${field} failed for student ${name}`);
            }
            return 1;
        }
    }

    public async transformGrades(): Promise<void> {
        Log.info("AppendGradeComments::process() - start for delivId: " + this.DELIVID);

        this.loadRegressionScores();
        this.loadRetroScores();
        Log.info(this.regressionScoreMap);
        Log.info(this.retroScoreMap);

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
        Log.info("AppendGradeComments::process() - for: " + this.DELIVID + "; # grades: " + grades.length);

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
                if (typeof (result.output.report.custom as any).private === 'undefined' ||
                    typeof (result.output.report.custom as any).private.scoreTest === 'undefined'
                ) {
                    Log.warn("WARNING: NO PRIVATE RECORD; filling with 0s");

                    (result.output.report.custom as any).private = {};
                    (result.output.report.custom as any).private.scoreTest = 0;

                    continue; // just skip this row; this is a fatal error though that we need to figure out
                }

                const scorePub = Number(result.output.report.scoreTest);
                const scorePriv = Number((result.output.report.custom as any).private.scoreTest);
                const scorePubOverall = Number(result.output.report.scoreOverall);

                let finalScore = (scorePub * this.PUB_MULT) + (scorePriv * this.PRIV_MULT);
                finalScore = Number(finalScore.toFixed(2));
                Log.info("Updating grade for " + this.DELIVID + "; original: " +
                    scorePubOverall.toFixed(0) + "; new: " + finalScore.toFixed(0));

                // if there's a big difference, print a warning
                if ((scorePub - scorePriv) > 20) {
                    Log.warn("Divergent score between public and private; original: " +
                        scorePubOverall.toFixed(0) + "; new: " + finalScore.toFixed(0));
                }

                let newGrade: Grade = JSON.parse(JSON.stringify(grade)); // Object.assign is a shallow copy which doesn't work here
                (newGrade.custom as any).publicGrade = grade; // keep the old grade record around in the grade.custom field
                newGrade.timestamp = Date.now(); // TS for when we updated the grade record

                // change grade
                newGrade.urlName = "Transformed";
                newGrade.URL = `https://www.students.cs.ubc.ca/~cs-310/2019W2/reports/c1/${result.repoId}/index.html`;
                newGrade.score = finalScore;

                newGrade = this.applyRegressionScore(newGrade, result.repoId);
                newGrade = this.applyRetroScores(newGrade);

                gradeDeltas.push(Number((newGrade.score - grade.score).toFixed(2))); // track delta

                Log.info("Student comment for", newGrade.personId, ":", newGrade.comment);
                Log.info("AppendGradeComments::process() - processing result: " + url);
                Log.info("Full new grade object:", newGrade);
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
                Log.warn("AppendGradeComments::process - WARN; no grade found for: " + url);
            }
        }

        // Log.info('gradeDeltas: ' + JSON.stringify(gradeDeltas));
        let gradeIncreased = 0;
        let gradeDecreased = 0;
        let gradeUnchanged = 0;
        let increasedAmount = 0;
        let decreasedAmount = 0;

        for (const delta of gradeDeltas) {
            if (delta > 0) {
                gradeIncreased++;
                increasedAmount += delta;
            } else if (delta < 0) {
                gradeDecreased++;
                decreasedAmount += delta;
            } else {
                // unchanged
                gradeUnchanged++;
            }
        }

        Log.info("*** Transformation Summary ***");
        Log.info("# increased: " + gradeIncreased + "; by avg: " + (increasedAmount / gradeIncreased).toFixed(2));
        Log.info("# decreased: " + gradeDecreased + "; by avg: " + (decreasedAmount / gradeDecreased).toFixed(2));
        Log.info("# unchanged: " + gradeUnchanged);
        Log.info("Average change: " +
            ((decreasedAmount + increasedAmount) / (gradeDecreased + gradeIncreased + gradeUnchanged)).toFixed(2));
        Log.info("*** /Transformation Summary ***");

        Log.info("AppendGradeComments::process() - done");
    }
}

const transformer = new TransformGrades();
const start = Date.now();
Log.Level = LogLevel.INFO;
transformer.transformGrades().then(function() {
    Log.info("AppendGradeComments::process() - complete; took: " + Util.took(start));
    process.exit();
}).catch(function(err) {
    Log.error("AppendGradeComments::process() - ERROR: " + err.message);
    process.exit();
});
