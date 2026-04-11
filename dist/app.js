import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
import publicRoutes from "./routes/public.js";
import applicationsRouter from "./routes/applications.js";
import documentsRouter from "./routes/documents.js";
import pipelineRouter from "./routes/pipeline.js";
import usersRouter from "./routes/users.js";
import crmRouter from "./routes/crm.js";
import voiceTokenRouter from "./routes/voiceToken.js";
import { requireAuth } from "./middleware/auth.js";
import { createLead } from "./modules/lead/lead.service.js";
import { respondOk } from "./utils/respondOk.js";

export function createApp() {
    const app = express();
    const HARDCODED_ALLOWED_ORIGINS = [
        "https://staff.boreal.financial",
        "https://client.boreal.financial",
        "https://boreal.financial",
        "https://www.boreal.financial",
    ];
    const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
    const allowedOrigins = [...new Set([...envOrigins, ...HARDCODED_ALLOWED_ORIGINS])];

    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(null, false);
        },
        credentials: true,
    }));
    app.use(express.json({ limit: "10mb" }));
    app.use(cookieParser());

    app.get("/health", (_req, res) => { res.status(200).json({ status: "ok" }); });
    app.get("/api/_int/health", (_req, res) => { res.status(200).json({ status: "ok" }); });
    app.get("/api/_int/production-readiness", requireAuth, (_req, res) => { res.status(200).json({ status: "ok" }); });

    app.use("/api/auth", authRoutes);
    app.use("/api/call", callRoutes);
    app.use("/api/health", healthRoutes);
    app.use("/api/public", publicRoutes);
    app.use("/api/applications", requireAuth, applicationsRouter);
    app.use("/api/client/applications", applicationsRouter);
    app.use("/api/documents", requireAuth, documentsRouter);
    app.use("/api/pipeline", requireAuth, pipelineRouter);
    app.use("/api/users", requireAuth, usersRouter);
    app.use("/api/crm", requireAuth, crmRouter);

    app.get("/api/crm/leads/count", requireAuth, (_req, res) => { res.json({ count: 0 }); });
    app.get("/api/support/live/count", requireAuth, (_req, res) => { res.json({ count: 0 }); });

    app.post("/api/voice/device-token", requireAuth, (_req, res) => { res.json({ status: "ok", data: { registered: true } }); });
    app.post("/api/voice/calls/answer", requireAuth, (_req, res) => { res.json({ status: "ok", data: { answered: true } }); });
    app.post("/api/voice/calls/end", requireAuth, (_req, res) => { res.json({ status: "ok", data: { ended: true } }); });
    app.get("/api/voice/calls/log", requireAuth, (_req, res) => { res.json({ status: "ok", data: { calls: [] } }); });
    app.post("/api/voice/record/start", requireAuth, (_req, res) => { res.json({ status: "ok", data: { recording: true } }); });
    app.post("/api/voice/record/stop", requireAuth, (_req, res) => { res.json({ status: "ok", data: { recording: false } }); });
    app.post("/api/sms/send", requireAuth, (_req, res) => { res.json({ status: "ok", data: { sent: true } }); });

    app.use("/api", voiceTokenRouter);

    app.get("/api/telephony/token", requireAuth, (_req, res, next) => { res.redirect(307, "/api/voice/token"); });
    app.get("/api/dialer/token", requireAuth, (_req, res, next) => { res.redirect(307, "/api/voice/token"); });

    app.post("/api/v1/crm/lead", async (req, res) => {
        try {
            const payload = {
                source: req.body?.source ?? "website",
                companyName: req.body?.company_name ?? req.body?.companyName ?? req.body?.businessName,
                fullName: req.body?.full_name ?? req.body?.fullName ?? req.body?.name,
                email: req.body?.email,
                phone: req.body?.phone,
                requestedAmount: req.body?.requested_amount ?? req.body?.requestedAmount ?? req.body?.fundingAmount,
                monthlyRevenue: req.body?.monthly_revenue ?? req.body?.monthlyRevenue,
                annualRevenue: req.body?.annual_revenue ?? req.body?.annualRevenue,
                productInterest: req.body?.product_interest ?? req.body?.productInterest ?? req.body?.product,
                industryInterest: req.body?.industry_interest ?? req.body?.industryInterest ?? req.body?.industry,
                notes: req.body?.notes ?? req.body?.message,
                tags: req.body?.tags,
            };
            const result = await createLead(payload);
            return respondOk(res, result);
        } catch (err) {
            return res.status(500).json({ status: "error", message: err?.message ?? "Failed" });
        }
    });

    app.use((req, res) => { res.status(404).json({ error: "Route not found", path: req.path }); });
    app.use((err, _req, res, _next) => {
        console.error("SERVER ERROR:", err);
        res.status(500).json({ error: "Internal server error" });
    });

    return app;
}
