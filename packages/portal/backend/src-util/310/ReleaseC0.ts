import Log, {LogLevel} from "../../../../common/Log";
import Util from "../../../../common/Util";

import {Grade, Result} from "../../src/Types";
import {ReleaseCheckpoint} from "./ReleaseCheckpoint";

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
export class ReleaseC0 extends ReleaseCheckpoint {
    /**
     * Whether the execution is for testing (true) or should actually change the database (false).
     *
     * @type {boolean}
     */
    protected DRY_RUN = true;

    /**
     * A test user that can be used for checking DB writing (ignores DRY_RUN above, but only for this user).
     *
     * @type {string}
     */
    protected readonly TEST_USER = 'XXXXX';

    /**
     * The delivId we are updating grades for.
     *
     * @type {string}
     */
    protected readonly DELIVID: string = 'c0';

    protected RETRO_PATH = `${__dirname}/c0retros.csv`;

    protected AUDIT_ID = 'ReleaseC0';

    protected loadRetroScores(): RetroScoreMap {
        const data = this.loadRetroData();
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

    protected fillMissingData(result: Result): Result {
        return result;
    }

    protected async transformGrade(result: Result, grade: Grade): Promise<Grade> {
        return grade;
    }

}

interface RetroScoreMap {
    [id: string]: {feedback: string, score: number};
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
