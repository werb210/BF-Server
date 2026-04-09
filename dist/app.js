import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
export function createApp() {
    const app = express();
    /**
     * CORE MIDDLEWARE
     */
    app.use(cors({
        origin: true,
        credentials: true,
    }));
    app.use(express.json({ limit: "10mb" }));
    app.use(cookieParser());
    /**
     * HEALTH (MUST NOT BE CAUGHT BY FRONTEND)
     */
    app.get("/health", (_req, res) => {
        res.status(200).json({ status: "ok" });
    });
    app.get("/api/_int/health", (_req, res) => {
        res.status(200).json({ status: "ok" });
    });
    /**
     * API ROUTES (LOCKED PREFIX)
     */
    app.use("/api/auth", authRoutes);
    app.use("/api/call", callRoutes);
    app.use("/api/health", healthRoutes);
    /**
     * 404 HANDLER
     */
    app.use((req, res) => {
        res.status(404).json({
            error: "Route not found",
            path: req.originalUrl,
        });
    });
    /**
     * GLOBAL ERROR HANDLER
     */
    app.use((err, _req, res, _next) => {
        console.error("SERVER ERROR:", err);
        res.status(500).json({
            error: "Internal Server Error",
            message: err?.message ?? "Unknown error",
        });
    });
    return app;
}
const app = createApp();
export default app;
export function resetOtpStateForTests() {
    // no-op: current auth flow is route-local in-memory state
}
