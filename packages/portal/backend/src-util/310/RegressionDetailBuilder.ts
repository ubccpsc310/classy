import {AutoTestResult} from "../../../../common/types/AutoTestTypes";
import {PersonController} from "../../src/controllers/PersonController";
import {Grade, Result} from "../../src/Types";

import * as fs from "fs-extra";

const personC = new PersonController();

export async function build(sortedResults: AutoTestResult[], gradedResult: Result, grade: Grade, term: string): Promise<void> {

    const person = await personC.getPerson(grade.personId);
    const cwl = person.githubId;
    const deliv = grade.delivId;

    const htaccess = buildHTAccess(cwl);
    const html = buildHTML(grade.personId, sortedResults, gradedResult);

    const toPath = (fileName: string) => `${__dirname}/html/${term}/reports/${deliv}/${grade.personId}/${fileName}`;

    const saveHTAccess = fs.outputFile(toPath(".htaccess"), htaccess);
    const saveHTML = fs.outputFile(toPath("index.html"), html);
    await Promise.all([saveHTAccess, saveHTML]);
}

function buildHTAccess(cwl: string): string {
    return `SSLRequireSSL
AuthType Basic
AuthName "UBC CPSC Handback"
AuthBasicProvider ldap-domain
Require user timkl ebani cs-310 braxtonh schieft falkirks ${cwl}
`;
}

function buildHTML(personId: string, results: AutoTestResult[], gradedResult: Result) {
    return `<!DOCTYPE html>
<html>
<head>
	<title>Commit Report</title>
	<style type="text/css">
		.MAIN {
			font: 100% 'Courier New', Courier, monospace;
		}

	</style>
</head>
<body class="MAIN">
	<h1>${personId} - Commit Sequence</h1>
	<span>The commits are from master, sorted oldest to newest.</span>
	<table>
		<thead>
			<tr>
				<th>
					SHA
				</th>
			</tr>
		</thead>
		<tbody>
			${createRows(results)}
		</tbody>
	</table>
	<h1>${personId} - Graded Commit</h1>
	<a href="${gradedResult.commitURL}">${gradedResult.input.target.commitSHA.slice(0, 7)}</a>
</body>
</html>`;
}

function createRows(results: AutoTestResult[]) {
    return results.map(buildRow).join("\n");
}

function buildRow(result: AutoTestResult) {
    return `<tr>
				<td>
					<a href="${result.commitURL}">${result.input.target.commitSHA.slice(0, 7)}</a>
				</td>
			</tr>`;
}
