import * as csvParse from "csv-parse/lib/sync";
import * as fs from "fs-extra";
import Log, {LogLevel} from "../../../../common/Log";
import {TeamFormationTransport} from "../../../../common/types/PortalTypes";
import {DatabaseController} from "../../src/controllers/DatabaseController";
import {GitHubActions, IGitHubActions} from "../../src/controllers/GitHubActions";
import {GitHubController, Issue} from "../../src/controllers/GitHubController";
import {PersonController} from "../../src/controllers/PersonController";
import {RepositoryController} from "../../src/controllers/RepositoryController";
import {TeamController} from "../../src/controllers/TeamController";
import AdminRoutes from "../../src/server/common/AdminRoutes";
import {AuditLabel, Person, Repository, Team} from "../../src/Types";

/**
 * To run this locally you need to have a .env configured with the production values
 * and a ssh tunnel configured to the server you want the database to come from.
 *
 * 1) Get on the VPN
 * 2) Make sure you don't have a local mongo instance running
 * 3) Ensure your .env corresponds to the production values; change DB_URL connection string to use 127.0.0.1
 *      * specifically, make sure DB_URL contains the mongo username and password
 * 4) ssh user@host -L 27017:127.0.0.1:27017
 * 5) Run this script: node packages/portal/backend/src-util/310/BreakupTeam.js
 */

interface ResponseMap {
    [csid: string]: string;
}

const DRY_RUN: boolean = true;
const DELIV = "project";
const RETRO_PATH = __dirname + "/c2retros.csv";

const parserOptions = {
    columns:          true,
    skip_empty_lines: true,
    trim:             true
};

let newTeamCount = 0;

const teamsController: TeamController = new TeamController();
const personController: PersonController = new PersonController();
const githubActions: IGitHubActions = GitHubActions.getInstance();
const githubController: GitHubController = new GitHubController(githubActions);
const repoController: RepositoryController = new RepositoryController();
const dbc = DatabaseController.getInstance();
let responseMap: ResponseMap;

function loadRetroScores(): ResponseMap {
    const map: ResponseMap = {};
    if (!fs.existsSync(RETRO_PATH)) {
        throw new Error("Retro score CSV does not exist");
    }
    const csvData = fs.readFileSync(RETRO_PATH).toString();
    const data = csvParse(csvData, parserOptions);

    for (const record of data) {
        for (const [csidCol, resCol] of [["Q4", "Q8"], ["Q9", "Q13"], ["Q14", "Q18"]]) {
            const csid = record[csidCol].toLowerCase();
            map[csid] = record[resCol];
        }
    }

    return map;
}

async function studentWantsOut(id: string): Promise<boolean> {
    let key;
    if (responseMap[id]) {
        key = id;
    } else {
        const person = await personController.getPerson(id);
        key = person.githubId;
    }
    return responseMap[key] === "This student wants to work alone";
}

async function removeStudentFromTeam(student: string, team: Team): Promise<void> {
    const person = await personController.getPerson(student);
    const repos = await repoController.getReposForPerson(person);
    const repo: Repository = repos.find((r) => r.delivId === "project");
    Log.info(`Removing ${person.csId} from ${team.id}`);
    if (DRY_RUN === false) {
        // @ts-ignore don't @ me
        await AdminRoutes.handleTeamRemoveMember('ProcessBreakupTeam', team.id, person.githubId);
        await githubController.createIssues(repo, [createIssue(person)]);
    }
}

function createIssue(student: Person): Issue {
    return {
        body: `Hello!\n\nThis is to let you know that your team member, ${student.fName}, is no longer a contributor to this repo.`,
        title: "Team member departure warning",
    };
}

async function formNewTeam(student: string): Promise<void> {
    const person = await personController.getPerson(student);
    const team: TeamFormationTransport = {
        delivId:   DELIV,
        githubIds: [person.githubId]
    };
    Log.info(`Creating a new team for ${team.delivId} with students ${team.githubIds}`);
    if (DRY_RUN === false) {
        // @ts-ignore don't @ me
        await AdminRoutes.handleTeamCreate('ProcessBreakupTeam', team);
    }
    newTeamCount++;
}

async function deleteTeam(team: Team): Promise<void> {
    Log.info(`Deleting team ${team.id}`);
    if (DRY_RUN as boolean === false) {
        // Intentionally not using the admin route because I want to keep the github repo
        await dbc.deleteTeam(team);
        await dbc.writeAudit(AuditLabel.TEAM, 'ProcessBreakupTeam', team, null, {});
    }
}

async function moveStudentToNewTeam(student: string, team: Team): Promise<void> {
    try {
        await removeStudentFromTeam(student, team);
        await formNewTeam(student);
    } catch (err) {
        Log.error(`Error removing ${student} from ${team.id}: ${err}`);
    }
}

async function removeStudentsWhoWantOut(team: Team): Promise<void>  {
    const students = team.personIds;
    for (const student of students) {
        if (await studentWantsOut(student)) {
            await moveStudentToNewTeam(student, team);
        }
    }
}

// tslint:disable-next-line
(async () => {
    Log.Level = LogLevel.INFO;
    responseMap = loadRetroScores();
    const teams = await teamsController.getAllTeams();
    const delivTeams = teams.filter((t) => t.delivId === DELIV);
    for (const team of delivTeams) {
        await removeStudentsWhoWantOut(team);
    }
    Log.info(`New team total: ${newTeamCount}`);

    const updatedTeams = await teamsController.getAllTeams();
    const emptyUpdatedDelivTeams = updatedTeams.filter((t) => t.delivId === DELIV && t.personIds.length === 0);
    for (const emptyTeam of emptyUpdatedDelivTeams) {
        await deleteTeam(emptyTeam);
    }
    Log.info(`Deleted ${emptyUpdatedDelivTeams.length} teams`);
    process.exit(0);
})();
