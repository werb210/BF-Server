import { toStringSet } from "../utils/collectionSafe.js";
import { Router } from "express";
import { withRetry, withRetryAndTimeout } from "../utils/retry.js";
import { createSupportThread } from "../services/supportService.js";
import { dbQuery } from "../db.js";
import { fetchTwilioClient } from "../services/twilio.js";
import { pushLeadToCRM } from "../services/crmWebhook.js";
import { SupportController } from "../modules/support/support.controller.js";
import { logger } from "../server/utils/logger.js";
import { config } from "../config/index.js";
import { safeCall } from "../lib/circuitBreaker.js";
const router = Router();
const TABLE_CACHE_TTL_MS = 10 * 60 * 1000;
const tableColumnCache = new Map();
function setTableColumnsCache(table, columns) {
    tableColumnCache.set(table, { columns, expiresAt: Date.now() + TABLE_CACHE_TTL_MS });
}
async function fetchTableColumns(table) {
    const cached = tableColumnCache.get(table);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.columns;
    }
    if (cached) {
        tableColumnCache.delete(table);
    }
    const { rows } = await dbQuery(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table]);
    const columns = toStringSet(rows.map((row) => row.column_name));
    setTableColumnsCache(table, columns);
    return columns;
}
router.post("/live", async (req, res, next) => {
    const { source, sessionId } = req.body;
    if (!source || !sessionId) {
        return res.status(400).json({ error: "Missing source or sessionId" });
    }
    await dbQuery(`insert into live_chat_requests (source, session_id, status)
     values ($1, $2, 'pending')`, [source, sessionId]);
    return res["json"]({ success: true });
});
router.get("/live", async (_req, res) => {
    const { rows } = await dbQuery(`select id, source, session_id, status, created_at
     from live_chat_requests
     where status = 'pending'
     order by created_at desc`);
    res["json"](rows);
});
router.get("/live/count", async (_req, res) => {
    const { rows } = await dbQuery(`select count(*)::text as count
     from live_chat_requests
     where status = 'pending'`);
    res["json"]({ count: Number(rows[0]?.count ?? "0") });
});
router.post("/human", async (req, res, next) => {
    const { message, user } = req.body;
    await withRetry(async () => {
        await createSupportThread({
            type: "chat_escalation",
            description: message ?? "Human support request",
            source: user ?? "unknown",
        });
    });
    logger.info("human_chat_request", { message });
    res["json"]({ success: true });
});
router.post("/report", async (req, res, next) => {
    const { message, description, screenshot, route } = req.body;
    const resolvedDescription = description ?? message;
    const columns = await fetchTableColumns("issue_reports");
    const insertColumns = [];
    const placeholderParts = [];
    const values = [];
    if (columns.has("id")) {
        insertColumns.push("id");
        placeholderParts.push("gen_random_uuid()");
    }
    const pushValue = (column, value) => {
        if (!columns.has(column)) {
            return;
        }
        insertColumns.push(column);
        values.push(value);
        placeholderParts.push(`$${values.length}`);
    };
    pushValue("description", resolvedDescription ?? "Issue reported");
    pushValue("screenshot_base64", screenshot ?? null);
    pushValue("user_agent", req.headers["user-agent"] ?? "unknown");
    pushValue("page_url", route ?? "unknown");
    pushValue("browser_info", req.headers["user-agent"] ?? "unknown");
    pushValue("screenshot_path", screenshot ?? null);
    pushValue("status", "open");
    if (insertColumns.length === 0) {
        await dbQuery("insert into issue_reports default values");
    }
    else {
        await dbQuery(`insert into issue_reports (${insertColumns.join(", ")}) values (${placeholderParts.join(", ")})`, values);
    }
    await withRetry(async () => {
        await createSupportThread({
            type: "issue_report",
            ...(resolvedDescription ? { description: resolvedDescription } : {}),
            ...(screenshot ? { screenshotBase64: screenshot } : {}),
            ...(route ? { route } : {}),
        });
    });
    logger.info("issue_reported", { description: resolvedDescription ?? null });
    res["json"]({ success: true });
});
router.post("/contact", async (req, res, next) => {
    const { company, firstName, lastName, email, phone } = req.body;
    if (!company || !firstName || !lastName || !email || !phone) {
        return res.status(400).json({ error: "Missing fields" });
    }
    await dbQuery(`insert into contact_leads (company, first_name, last_name, email, phone)
     values ($1, $2, $3, $4, $5)`, [company, firstName, lastName, email, phone]);
    const client = fetchTwilioClient();
    await safeCall(() => withRetryAndTimeout(() => client.messages.create({
        body: `New Contact: ${company} - ${firstName} ${lastName} - ${phone}`,
        from: config.twilio.phone,
        to: "+15878881837",
    }), 3, 8_000));
    await safeCall(() => withRetryAndTimeout(() => pushLeadToCRM({
        type: "contact_form",
        company,
        firstName,
        lastName,
        email,
        phone,
    }), 3, 8_000));
    return res["json"]({ success: true });
});
router.post("/track", async (req, res, next) => {
    const { event, metadata } = req.body;
    logger.info("support_track_event", { event: event ?? null, metadata: metadata ?? null });
    return res["json"]({ success: true });
});
router.post("/session", SupportController.createSession);
router.get("/queue", SupportController.fetchQueue);
router.post("/issue", SupportController.createIssue);
router.get("/issues", SupportController.fetchIssues);
router.post("/event", SupportController.trackEvent);
router.get("/events", SupportController.fetchEvents);
export default router;
