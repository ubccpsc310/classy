import Log, {LogLevel} from "../../../../common/Log";
import Util from "../../../../common/Util";
import {AuditLabel, Grade, PersonKind} from "../../src/Types";
import {ReleaseC1} from "./ReleaseC1";

// TODO this is a bad class hierarchy
class FillC1 extends ReleaseC1 {
    protected readonly DRY_RUN: boolean = true;
    protected readonly TEST_USER: string = "XXXX";
    protected readonly AUDIT_ID: string = 'FillC1';
    protected readonly TERM: string = "2020W1";

    public async process(): Promise<void> {
        Log.info("FillC1::process() - start for delivId: " + this.DELIVID);
        this.retroScores = this.loadRetroScores();

        const people = await this.personC.getAllPeople();
        const students = people.filter((person) => person.kind === PersonKind.STUDENT);

        for (const student of students) {
            Log.trace("FillC1::process() - Considering", student.csId);
            const grade = await this.gradesC.getGrade(student.csId, this.DELIVID);
            if (grade === null) {
                Log.info("FillC1::process() - Creating new grade for", student.csId);
                const newGrade: Grade = {
                    personId: student.csId,
                    delivId: this.DELIVID,
                    score: 0,
                    comment: "",
                    timestamp: Date.now(),
                    urlName: "Fill",
                    URL: student.URL,
                    custom: {
                        regression: {
                            preRegression: 0,
                            penalty: 0,
                            postRegression: 0,
                        }
                    },
                };
                const finalGrade = await this.applyRetroScore(newGrade);
                Log.info(finalGrade.custom);
                if (this.DRY_RUN === false || finalGrade.personId === this.TEST_USER) {
                    // publish grade
                    Log.info("Grade update for: " + finalGrade.personId);
                    await this.gradesC.saveGrade(finalGrade);
                    await this.dc.writeAudit(AuditLabel.GRADE_CHANGE, this.AUDIT_ID, grade, finalGrade, {});
                } else {
                    Log.info("Dry run grade update for: " + finalGrade.personId);
                }
            }
        }
    }
}

const ppt = new FillC1();
const start = Date.now();
Log.Level = LogLevel.INFO;
ppt.process().then(() => {
    Log.info("FillC1::process() - complete; took: " + Util.took(start));
    process.exit();
}).catch((err) => {
    Log.error("FillC1::process() - ERROR: " + err.message);
    process.exit();
});
