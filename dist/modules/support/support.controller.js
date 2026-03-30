"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupportController = void 0;
const uuid_1 = require("uuid");
const supportSessions = [];
const issueReports = [];
const websiteEvents = [];
const webLeads = [];
const MAX_ITEMS = 500;
function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_ITEMS) {
        arr.shift();
    }
}
exports.SupportController = {
    createSession(req, res) {
        const session = {
            id: (0, uuid_1.v4)(),
            source: req.body.source ?? "website",
            createdAt: Date.now(),
            status: "open",
        };
        pushBounded(supportSessions, session);
        res["json"]({ success: true, session });
    },
    fetchQueue(_req, res) {
        res["json"]({ sessions: supportSessions.filter((session) => session.status === "open") });
    },
    createIssue(req, res) {
        const payload = req.body;
        const issue = {
            id: (0, uuid_1.v4)(),
            description: payload.description,
            hasScreenshot: Boolean(payload.screenshot),
            createdAt: Date.now(),
        };
        pushBounded(issueReports, issue);
        res["json"]({ success: true });
    },
    fetchIssues(_req, res) {
        res["json"]({ issues: issueReports });
    },
    createWebLead(req, res) {
        const lead = {
            id: (0, uuid_1.v4)(),
            ...req.body,
            createdAt: Date.now(),
        };
        pushBounded(webLeads, lead);
        res["json"]({ success: true });
    },
    fetchWebLeads(_req, res) {
        res["json"]({ leads: webLeads });
    },
    trackEvent(req, res) {
        const payload = req.body;
        pushBounded(websiteEvents, {
            event: payload.event,
            source: payload.source,
            timestamp: Date.now(),
        });
        res["json"]({ success: true });
    },
    fetchEvents(_req, res) {
        res["json"]({ events: websiteEvents.slice(-100) });
    },
};
