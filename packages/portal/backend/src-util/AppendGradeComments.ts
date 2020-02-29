import * as csvParse from 'csv-parse/lib/sync';
import * as fs from 'fs-extra';
import Log, {LogLevel} from "../../../common/Log";
import Util from "../../../common/Util";

import {DatabaseController} from "../src/controllers/DatabaseController";
import {GradesController} from "../src/controllers/GradesController";
import {ResultsController} from "../src/controllers/ResultsController";

import {AuditLabel, Grade} from "../src/Types";
// TODO this whole file should not exist. Merge logic into transform grades before merging
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
export class AppendGradeComments {

    private dc: DatabaseController;

    private retroPath = `${__dirname}/c1retros.csv`;
    private retroCommentMap: {[student: string]: string} = {};

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

    // TODO move this into TransformGrades
    public loadRetroComments() {
        const csvData = fs.readFileSync(this.retroPath).toString();
        const data = csvParse(csvData, this.parserOptions);
        for (const record of data) {
            const member1 = record["Q1.5"].toLowerCase();
            const member1Comment = record["Q2.10"];
            const member2 = record["Q24"].toLowerCase();
            const member2Comment = record["Q36"];
            const member3 = record["Q52"].toLowerCase();
            const member3Comment = record["Q48"];
            this.retroCommentMap[member1] = member1Comment;
            this.retroCommentMap[member2] = member2Comment;
            this.retroCommentMap[member3] = member3Comment;
        }
    }

    public appendRetroComment(grade: Grade) {
        const comment = this.retroCommentMap[grade.personId];
        const retroComment = typeof comment !== "undefined" ? comment : "";
        Log.info(`Appending retro comment to ${grade.personId}. Would be "${retroComment}"`);
        grade.custom.c1RetroComment = retroComment;
        if (grade.comment === undefined) {
            grade.comment = "";
        }
        if (retroComment !== "") {
            grade.comment += `Retrospective comment: ${retroComment}.\n`;
        }
        return grade;
    }

    public async transformGrades(): Promise<void> {
        Log.info("AppendGradeComments::process() - start for delivId: " + this.DELIVID);

        this.loadRetroComments();
        Log.info(this.retroCommentMap);

        const gradesC = new GradesController();
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

        for (const grade of grades) {
            Log.info("Considering grade comment for " + this.DELIVID + " for url: " + grade.personId);

            const newGrade = this.appendRetroComment(JSON.parse(JSON.stringify(grade)));

            Log.info("Student comment for", newGrade.personId, ":", newGrade.comment);
            Log.info("AppendGradeComments::process() - processing result: " + grade.personId);
            Log.info("Full new grade object:", newGrade);

            if (this.DRY_RUN === false || grade.personId === this.TEST_USER) {
                // publish grade
                Log.info("Grade update for: " + newGrade.personId);
                await gradesC.saveGrade(newGrade);
                await dbc.writeAudit(AuditLabel.GRADE_CHANGE, 'ProcessPrivateTest', grade, newGrade, {});
            } else {
                Log.info("Dry run grade update for: " + newGrade.personId);
            }
        }

        Log.info("AppendGradeComments::process() - done");
    }
}

const transformer = new AppendGradeComments();
const start = Date.now();
Log.Level = LogLevel.INFO;
transformer.transformGrades().then(function() {
    Log.info("AppendGradeComments::process() - complete; took: " + Util.took(start));
    process.exit();
}).catch(function(err) {
    Log.error("AppendGradeComments::process() - ERROR: " + err.message);
    process.exit();
});
