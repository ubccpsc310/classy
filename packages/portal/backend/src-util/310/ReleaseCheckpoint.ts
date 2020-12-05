import * as csvParse from 'csv-parse/lib/sync';
import * as fs from "fs-extra";

import Log from "../../../../common/Log";

import {DatabaseController} from "../../src/controllers/DatabaseController";
import {GradesController} from "../../src/controllers/GradesController";
import {ResultsController} from "../../src/controllers/ResultsController";

import {PersonController} from "../../src/controllers/PersonController";
import {AuditLabel, Grade, Result} from "../../src/Types";

/**
 * To run this locally you need to have a .env configured with the production values
 * and a ssh tunnel configured to the server you want the database to come from.
 *
 * 1) Get on the VPN
 * 2) Make sure you don't have a local mongo instance running
 * 3) Ensure your .env corresponds to the production values; change DB_URL connection string to use 127.0.0.1
 *      * specifically, make sure DB_URL contains the mongo username and password
 * 4) ssh user@host -L 27017:127.0.0.1:27017
 * 5) Run this script: node packages/portal/backend/src-util/ReleaseCheckpoint.js
 */
export abstract class ReleaseCheckpoint {

    protected readonly dc: DatabaseController;
    protected readonly resultsC: ResultsController;
    protected readonly gradesC: GradesController;
    protected readonly personC: PersonController;

    /**
     * Whether the execution is for testing (true) or should actually change the database (false).
     *
     * @type {boolean}
     */
    protected abstract readonly DRY_RUN: boolean;

    /**
     * A test user that can be used for checking DB writing (ignores DRY_RUN above, but only for this user).
     *
     * @type {string}
     */
    protected abstract readonly TEST_USER: string;

    /**
     * The delivId we are updating grades for.
     *
     * @type {string}
     */
    protected abstract readonly DELIVID: string;

    protected abstract readonly AUDIT_ID: string;
    protected abstract readonly RETRO_PATH: string;

    protected retroScores: RetroScoreMap;

    protected parserOptions = {
        columns:          true,
        skip_empty_lines: true,
        trim:             true
    };

    constructor() {
        Log.info("ReleaseCheckpoint::<init> - start");
        this.dc = DatabaseController.getInstance();
        this.gradesC = new GradesController();
        this.resultsC = new ResultsController();
        this.personC = new PersonController();
    }

    protected abstract loadRetroScores(): RetroScoreMap;

    protected loadRetroData() {
        if (!fs.existsSync(this.RETRO_PATH)) {
            throw new Error("Retro score CSV does not exist");
        }
        const csvData = fs.readFileSync(this.RETRO_PATH).toString();
        return csvParse(csvData, this.parserOptions);
    }

    protected async applyRetroScore(grade: Grade): Promise<Grade> {
        let key;
        if (this.retroScores[grade.personId]) {
            key = grade.personId;
        } else {
            // just in case a TA entered a CWL instead of a csid
            const person = await this.personC.getPerson(grade.personId);
            key = person.githubId;
        }
        const retroEntry = this.retroScores[key];
        if (retroEntry === undefined) {
            Log.warn(`Retro missing for ${grade.personId}`);
        }
        const score = retroEntry?.score ?? 0;
        const feedback = retroEntry?.feedback ?? "";
        const missingForm = retroEntry?.missingForm ?? false;

        let retroComment = `Retrospective Score: ${score}`;
        if (missingForm) {
            retroComment += "; No Contribution Form Submitted";
        }
        if (feedback !== "") {
            retroComment += `; TA Feedback: ${feedback}`;
        }

        grade.comment = retroComment;
        grade.custom.retroScore = score;

        return grade;
    }

    protected isInvalidRow(row: any): boolean {
        return row.output?.report?.scoreTest === undefined ||
            row.output?.report?.scoreOverall === undefined ||
            row.output?.report?.custom === undefined;
    }

    protected abstract fillMissingData(result: Result): Result;

    protected abstract transformGrade(result: Result, grade: Grade): Promise<Grade>;

    public async process(): Promise<void> {
        Log.info("TransformGrades::process() - start for delivId: " + this.DELIVID);
        this.retroScores = this.loadRetroScores();

        // get all the DELIVID grade records eligible for updating
        const allGrades = await this.gradesC.getAllGrades();
        const grades = [];
        for (const grade of allGrades as Grade[]) {
            if (grade.delivId === this.DELIVID) {
                grades.push(grade);
            }
        }

        // should be one per student
        Log.info("TransformGrades::process() - for: " + this.DELIVID + "; # grades: " + grades.length);

        const gradeDeltas: number[] = [];

        for (const grade of grades) {
            const url = grade.URL;

            const possibleResult = await this.resultsC.getResultFromURL(url, this.DELIVID);
            if (possibleResult !== null) {

                Log.info("Considering grade for " + this.DELIVID + " for url: " + url);

                // make sure row is valid
                if (this.isInvalidRow(possibleResult)) {
                    Log.error("FATAL: NO GRADE RECORD");
                    break;
                }
                const result = this.fillMissingData(possibleResult);

                const newGrade: Grade = JSON.parse(JSON.stringify(grade)); // Object.assign is a shallow copy which doesn't work here
                newGrade.timestamp = Date.now(); // TS for when we updated the grade record

                // change grade
                // could add comment here too if needed (e.g., to newGrade.comment)
                newGrade.urlName = "Transformed";
                const withRetroScore = await this.applyRetroScore(newGrade);
                const transformedGrade = await this.transformGrade(result, withRetroScore);

                gradeDeltas.push(Number((transformedGrade.score - grade.score).toFixed(2))); // track delta

                Log.info("TransformGrades::process() - processing result: " + url);
                if (this.DRY_RUN === false || grade.personId === this.TEST_USER) {
                    // publish grade
                    Log.info("Grade update for: " + transformedGrade.personId);
                    await this.gradesC.saveGrade(transformedGrade);
                    await this.dc.writeAudit(AuditLabel.GRADE_CHANGE, this.AUDIT_ID, grade, transformedGrade, {});
                } else {
                    Log.info("Dry run grade update for: " + transformedGrade.personId);
                }
            } else {
                // should not really happen; if we have a grade already we must have a result
                Log.warn("TransformGrades::process - WARN; no grade found for: " + url);
            }
        }

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

        Log.info("TransformGrades::process() - done");
    }
}

export interface RetroScoreMap {
    [id: string]: {feedback: string, score: number, missingForm: boolean};
}
