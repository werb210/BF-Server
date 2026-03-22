import express from "express";
import otpRoutes from "./routes/auth/otp.js";
import applicationRoutes from "./routes/applications.js";
import documentRoutes from "./routes/documents.js";
import telephonyRoutes from "./routes/telephony.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
app.use(express.json());

app.use("/api/auth/otp", otpRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/telephony", telephonyRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(errorHandler);

export default app;
