import * as crypto from "crypto";
import * as Docker from "dockerode";
import * as http from "http";
import * as querystring from "querystring";
import * as restify from "restify";

import Config, {ConfigKey} from "@common/Config";
import Log from "@common/Log";
import {CommitTarget} from "@common/types/ContainerTypes";
import Util from "@common/Util";

import {AutoTest} from "../autotest/AutoTest";
import {ClassPortal} from "../autotest/ClassPortal";
import {MongoDataStore} from "../autotest/DataStore";
import {EdXClassPortal} from "../edx/EdxClassPortal";
import {GitHubAutoTest} from "../github/GitHubAutoTest";
import {GitHubUtil} from "../github/GitHubUtil";

export default class AutoTestRouteHandler {
    public static docker: Docker = null;
    public static autoTest: AutoTest = null;

    public static getDocker(): Docker {
        if (AutoTestRouteHandler.docker === null) {
            // NOTE: not sure what commenting this out will do in CI, but
            // seems right for local dev and will be fine in production

            // if (Config.getInstance().getProp(ConfigKey.name) === "classytest") {
            //     // Running tests; do not need to connect to the Docker daemon
            //     this.docker = null;
            // } else {
            // Connect to the Docker socket using defaults
            AutoTestRouteHandler.docker = new Docker();
            // }
        }

        return AutoTestRouteHandler.docker;
    }

    public static getAutoTest(): AutoTest {
        if (AutoTestRouteHandler.autoTest === null) {
            const dataStore = new MongoDataStore();
            const docker = AutoTestRouteHandler.getDocker();
            let portal: ClassPortal;

            if (Config.getInstance().getProp(ConfigKey.name) === "sdmm") {
                portal = new EdXClassPortal();
            } else {
                portal = new ClassPortal();
            }

            AutoTestRouteHandler.autoTest = new GitHubAutoTest(dataStore, portal, docker);
        }
        return AutoTestRouteHandler.autoTest;
    }

    /**
     * Makes sure the AutoTest server is started
     */
    public static getAutoTestStatus(req: restify.Request, res: restify.Response, next: restify.Next) {
        try {
            Log.info("RouteHanlder::getAutoTestStatus(..) - start");

            // should load AutoTest, if it has not been loaded already
            // if it is loading for the first time the queue will tick itself
            const at: GitHubAutoTest = AutoTestRouteHandler.getAutoTest() as GitHubAutoTest;

            // tick the queue again, in case it was not being loaded for the first time
            // feels odd to tick on status, but it might as well be up-to-date
            // and tick is idempotent
            at.tick();

            // get the status
            const status = at.getStatus();

            Log.info("RouteHanlder::getAutoTestStatus(..) - done");
            res.json(200, status);
        } catch (err) {
            Log.info("RouteHanlder::getAutoTestStatus(..) - ERROR: " + err);
            res.json(400, "Failed to check AutoTest: " + err.message);
        }
        return next();
    }

    /**
     * Handles GitHub POST events:
     * - ping
     * - commit_comment
     * - push
     */
    public static postGithubHook(req: restify.Request, res: restify.Response, next: restify.Next) {
        const start = Date.now();
        const githubEvent: string = req.header("X-GitHub-Event");
        let githubSecret: string = req.header("X-Hub-Signature");

        // https://developer.github.com/webhooks/securing/
        if (typeof githubSecret === "undefined") {
            githubSecret = null;
        }

        Log.info("AutoTestRouteHandler::postGithubHook(..) - start; handling event: " + githubEvent);
        const body = req.body;

        const handleError = function (msg: string) {
            Log.error("AutoTestRouteHandler::postGithubHook() - failure; ERROR: " + msg + "; took: " + Util.took(start));
            return res.json(400, "Failed to process commit: " + msg);
        };

        let secretVerified = false;
        if (githubSecret !== null) {
            try {
                Log.trace("AutoTestRouteHandler::postGithubHook(..) - trying to compute webhook secrets");

                const atSecret = Config.getInstance().getProp(ConfigKey.autotestSecret);
                const key = crypto.createHash("sha256").update(atSecret, "utf8").digest("hex"); // secret w/ sha256
                // Log.info("AutoTestRouteHandler::postGithubHook(..) - key: " + key); // should be same as webhook added key

                const computed = "sha1=" + crypto.createHmac("sha1", key) // payload w/ sha1
                    .update(JSON.stringify(body))
                    .digest("hex");

                secretVerified = (githubSecret === computed);
                if (secretVerified === true) {
                    Log.trace("AutoTestRouteHandler::postGithubHook(..) - webhook secret verified: " + secretVerified +
                        "; took: " + Util.took(start));
                } else {
                    Log.warn("AutoTestRouteHandler::postGithubHook(..) - webhook secrets do not match");
                    Log.warn("AutoTestRouteHandler::postGithubHook(..) - GitHub header: " + githubSecret + "; computed: " + computed);
                }
            } catch (err) {
                Log.error("AutoTestRouteHandler::postGithubHook(..) - ERROR computing HMAC: " + err.message);
            }
        } else {
            Log.warn("AutoTestRouteHandler::postGithubHook(..) - secret ignored (not present)");
        }

        // leave this on for a while; would like to verify that this works so we can replace the hardcode below
        Log.info("AutoTestRouteHandler::postGithubHook(..) - hasSecret: " +
            (typeof githubSecret === "string") + "; secretVerified: " + secretVerified);

        secretVerified = true; // TODO: stop overwriting this
        if (secretVerified === true) {
            if (githubEvent === "ping") {
                // github test packet; use to let the webhooks know we are listening
                Log.info("AutoTestRouteHandler::postGithubHook() - <200> pong.");
                return res.json(200, "pong");
            } else {
                AutoTestRouteHandler.handleWebhook(githubEvent, body).then(function (commitEvent) {
                    if (commitEvent !== null) {
                        Log.info("AutoTestRouteHandler::postGithubHook() - handle done; took: " + Util.took(start));
                        return res.json(200, commitEvent); // report back our interpretation of the hook
                    } else {
                        Log.info("AutoTestRouteHandler::postGithubHook() - handle done (branch deleted); took: " + Util.took(start));
                        return res.json(204, {}); // report back that nothing happened
                    }
                }).catch(function (err) {
                    Log.error("AutoTestRouteHandler::postGithubHook() - ERROR: " + err);
                    handleError(err);
                });
            }
        } else {
            handleError("Invalid payload signature.");
        }

        Log.trace("AutoTestRouteHandler::postGithubHook(..) - done handling event: " + githubEvent);
        return next();
    }

    private static async handleWebhook(event: string, body: string): Promise<CommitTarget> {
        // cast is unfortunate, but if we are listening to these routes it must be a GitHub AT instance
        const at: GitHubAutoTest = AutoTestRouteHandler.getAutoTest() as GitHubAutoTest;

        switch (event) {
            case "commit_comment":
                const commentEvent = await GitHubUtil.processComment(body);
                Log.trace("AutoTestRouteHandler::handleWebhook() - comment request: " + JSON.stringify(commentEvent, null, 2));
                await at.handleCommentEvent(commentEvent);
                return commentEvent;
            case "push":
                const pushEvent = await GitHubUtil.processPush(body, new ClassPortal());
                Log.trace("AutoTestRouteHandler::handleWebhook() - push request: " + JSON.stringify(pushEvent, null, 2));
                await at.handlePushEvent(pushEvent);
                return pushEvent;
            default:
                Log.error("AutoTestRouteHandler::handleWebhook() - Unhandled GitHub event: " + event);
                throw new Error("Unhandled GitHub hook event: " + event);
        }
    }

    // public static getResource(req: restify.Request, res: restify.Response, next: restify.Next) {
    //     const path = Config.getInstance().getProp(ConfigKey.persistDir) + "/" + req.url.split("/resource/")[1];
    //     Log.info("AutoTestRouteHandler::getResource(..) - start; fetching resource: " + path);
    //
    //     const rs = fs.createReadStream(path);
    //     rs.on("error", (err: any) => {
    //         if (err.code === "ENOENT") {
    //             Log.error("AutoTestRouteHandler::getResource(..) - ERROR Requested resource does not exist: " + path);
    //             res.send(404, err.message);
    //         } else {
    //             Log.error("AutoTestRouteHandler::getResource(..) - ERROR Reading requested resource: " + path);
    //             res.send(500, err.message);
    //         }
    //     });
    //     rs.on("end", () => {
    //         rs.close();
    //     });
    //     rs.pipe(res);
    //
    //     next();
    // }

    public static async getDockerImages(req: restify.Request, res: restify.Response, next: restify.Next) {
        try {
            const docker = AutoTestRouteHandler.getDocker();
            const filtersStr = req.query.filters;
            const options: any = {};
            if (filtersStr) {
                options["filters"] = JSON.parse(filtersStr);
            }
            Log.trace("AutoTestRouteHandler::getDockerImages(..) - Calling Docker listImages(..) with options: " + JSON.stringify(options));
            const images = await docker.listImages(options);
            res.send(200, images);
        } catch (err) {
            Log.error("AutoTestRouteHandler::getDockerImages(..) - ERROR Retrieving docker images: " + err.message);
            if (err.statusCode) {
                // Error from Docker daemon
                res.send(err.statusCode, err.message);
            } else {
                res.send(400, err.message);
            }
        }

        return next();
    }

    public static async postDockerImage(req: restify.Request, res: restify.Response, next: restify.Next) {
        Log.info("AutoTestRouteHandler::postDockerImage(..) - start");

        AutoTestRouteHandler.getDocker(); // make sure docker is configured

        try {
            if (typeof req.body.remote === "undefined") {
                throw new Error("remote parameter missing");
            }
            if (typeof req.body.tag === "undefined") {
                throw new Error("tag parameter missing");
            }
            if (typeof req.body.file === "undefined") {
                throw new Error("file parameter missing");
            }

            const handler = (stream: any) => {
                stream.on("data", (chunk: any) => {
                    Log.trace("AutoTestRouteHandler::postDockerImage(..)::stream; chunk:" + chunk.toString());
                });
                stream.on("end", (chunk: any) => {
                    Log.info("AutoTestRouteHandler::postDockerImage(..)::stream; end: Closing Docker API Connection.");
                    return next();
                });
                stream.on("error", (chunk: any) => {
                    Log.error("AutoTestRouteHandler::postDockerImage(..)::stream; Docker Stream ERROR: " + chunk);
                    return next();
                });
                stream.pipe(res);
            };

            const body = req.body as any;
            const tag = body.tag;
            const file = body.file;
            let remote;

            if (Config.getInstance().hasProp(ConfigKey.githubDockerToken) === true) {
                // repo protected by the githubDockerToken from .env
                const token = Config.getInstance().getProp(ConfigKey.githubDockerToken);
                remote = token ? body.remote.replace("https://", "https://" + token + "@") : body.remote;
            } else {
                // public repo
                remote = body.remote;
            }

            const dockerOptions = {remote, t: tag, dockerfile: file};
            const reqParams = querystring.stringify(dockerOptions);
            const reqOptions = {
                socketPath: "/var/run/docker.sock",
                path: "/v1.24/build?" + reqParams,
                method: "POST"
            };

            Log.info("AutoTestRouteHandler::postDockerImage(..) - making request with opts: " + JSON.stringify(reqOptions));
            const dockerReq = http.request(reqOptions, handler);
            dockerReq.end(0);
            Log.info("AutoTestRouteHandler::postDockerImage(..) - request made");

            // write something to the response to keep it alive until the stream is emitting
            res.write(""); // NOTE: this is required, if odd
        } catch (err) {
            Log.error("AutoTestRouteHandler::postDockerImage(..) - ERROR Building docker image: " + err.message);
            return res.send(err.statusCode, err.message);
        }
        // next not here on purpose, must be in stream handler or socket will close early
    }
}