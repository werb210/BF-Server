import { v4 as uuid } from "uuid";
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
export const SupportController = {
    createSession(req, res) {
        const session = {
            id: uuid(),
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
            id: uuid(),
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
            id: uuid(),
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
