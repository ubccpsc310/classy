import * as fs from "fs-extra";
import Log from "../../../../common/Log";
import {AutoTestResult} from "../../../../common/types/AutoTestTypes";
import {DeliverablesController} from "../../src/controllers/DeliverablesController";
import {Grade, Result} from "../../src/Types";
import {build} from "./RegressionDetailBuilder";
import {ReleaseCheckpoint, RetroScoreMap} from "./ReleaseCheckpoint";

export abstract class ReleasePubPrivCheckpoint extends ReleaseCheckpoint {
    private deadline: number;
    private delivC: DeliverablesController;

    protected abstract readonly ACCEPTANCE_TEST_COUNT: number;
    protected abstract readonly PUBLIC_TEST_COUNT: number;
    protected abstract readonly PRIVATE_TEST_COUNT: number;
    protected abstract readonly TERM: string;
    protected abstract readonly COLUMN_GROUPS: Array<[string, string, string]>;
    protected abstract readonly CONTRIBUTION_PATH: string;

    constructor() {
        super();
        this.delivC = new DeliverablesController();
    }

    protected fillMissingData(result: Result): Result {
        if (result.output.report.custom.private === undefined) {
            Log.warn("WARNING: NO PRIVATE RECORD; filling with 0s");
            result.output.report.custom.private = {scoreTest: 0};
        } else if (result.output.report.custom.private.scoreTest === undefined) {
            Log.warn("WARNING: PRIVATE RECORD INCOMPLETE; filling with 0s");
            result.output.report.custom.private.scoreTest = 0;
        }
        return result;
    }

    public async applyRegressionScore(grade: Grade, result: Result): Promise<Grade> {
        const regression = await this.getRegressionsFor(result, grade);
        Log.info(`Applying regression score to ${grade.personId}. Would be ${regression}`);
        grade.custom.regression = {
            preRegression: grade.score,
            penalty: regression,
            postRegression: grade.score - regression
        };

        if (regression > 0) {
            grade.comment += `; A regression penalty of ${regression}% was applied to this grade.`;
            grade.score -= regression;
        } else {
            grade.comment += `; No regressions were applied to this grade.`;
        }
        return grade;
    }

    public async process(): Promise<void> {
        const deliv = await this.delivC.getDeliverable(this.DELIVID);
        this.deadline = deliv.closeTimestamp;
        return super.process();
    }

    private getAcceptanceScore(result: AutoTestResult): number {
        const acceptanceCount = result?.output?.report?.custom?.cluster?.Acceptance?.passNames?.length ?? 0;
        return acceptanceCount / this.ACCEPTANCE_TEST_COUNT;
    }

    private async getRegressionsFor(result: Result, grade: Grade): Promise<number> {
        const results: AutoTestResult[] = await this.resultsC.getResults(this.DELIVID, result.repoId);
        const delivResults = results.filter(this.validResult.bind(this));
        const sortedResults = delivResults
            .sort((a, b) => a.input.target.timestamp - b.input.target.timestamp);
        await build(sortedResults, result, grade, this.TERM);
        const deltas = sortedResults.map(((autotestResult, index) => {
            const lastAcceptanceScore = this.getAcceptanceScore(sortedResults[index - 1]);
            const currentAcceptanceScore = this.getAcceptanceScore(autotestResult);
            return lastAcceptanceScore - currentAcceptanceScore;
        }));
        const positiveDeltas = deltas.filter((delta) => delta > 0);
        positiveDeltas.sort();
        if (positiveDeltas.length === 1) {
            Log.info("REGRESSION", grade.personId, "is getting away with a freebie!");
        } else if (positiveDeltas.length > 1) {
            Log.info("REGRESSION", grade.personId);
        }
        positiveDeltas.pop();
        const deltaSum = positiveDeltas.reduce((a, b) => a + b, 0);
        const regression = 100 * deltaSum * (this.ACCEPTANCE_TEST_COUNT / this.PUBLIC_TEST_COUNT) / 2;
        return Number(regression.toFixed(2));
    }

    private validResult(result: Result): boolean {
        return result.delivId === this.DELIVID &&
            result.output.state === "SUCCESS" &&
            result.input.target.ref === "refs/heads/master" &&
            result.output.report.scoreOverall > 0 &&
            result.input.target.timestamp <= this.deadline;
    }

    protected async transformGrade(result: Result, grade: Grade): Promise<Grade> {
        const scorePub = Number(result.output.report.scoreTest);
        const scoreCover = Number(result.output.report.scoreCover);
        const scorePriv = Number((result.output.report.custom as any).private.scoreTest);
        const scorePubOverall = Number(result.output.report.scoreOverall);

        const publicWeight = this.PUBLIC_TEST_COUNT / (this.PUBLIC_TEST_COUNT + this.PRIVATE_TEST_COUNT);
        const privateWeight = this.PRIVATE_TEST_COUNT / (this.PUBLIC_TEST_COUNT + this.PRIVATE_TEST_COUNT);

        const weightedScore = (scorePub * publicWeight) + (scorePriv * privateWeight);
        const fixedFinalScore = Number(weightedScore.toFixed(2));
        // if there's a big difference, print a warning
        if ((scorePub - scorePriv) > 20) {
            Log.warn(`Divergent score between public and private; original: ${scorePubOverall}; new: ${fixedFinalScore}`);
        }

        grade.score = fixedFinalScore;
        const withRegressions = await this.applyRegressionScore(grade, result);
        withRegressions.URL = `https://www.students.cs.ubc.ca/~cs-310/${this.TERM}/reports/${this.DELIVID}/${grade.personId}/index.html`;
        return withRegressions;
    }

    protected loadRetroScores(): RetroScoreMap {
        const data = this.loadRetroData();
        const contributionData = this.getContributionData();
        const retroMap: RetroScoreMap = {};
        for (const record of data) {
            for (const [csidCol, scoreCol, fbCol] of this.COLUMN_GROUPS) {
                const csid = record[csidCol].toLowerCase();
                let score = Number(record[scoreCol]);
                let feedback = record[fbCol];
                if (!contributionData.has(csid)) {
                    score = Math.min(score, 0.8);
                    feedback = `${feedback ? "; " : ""}No Retro Survey Form Submitted`;
                }
                retroMap[csid] = {feedback, score};
            }
        }
        return retroMap;
    }

    private getContributionData(): Set<string> {
        const contributionCSV = fs.readFileSync(this.CONTRIBUTION_PATH);
        // TODO
        return new Set<string>();
    }
}
