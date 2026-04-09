import express from "express";
import authRoutes from "./routes/auth.js";

const app = express();
app.use(express.json());

/**
 * Trust Azure proxy
 */
app.set("trust proxy", true);

/**
 * Health endpoints
 */
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/_int/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api/auth", authRoutes);

/**
 * Root check
 */
app.get("/", (_req, res) => {
  res.status(200).send("BF-SERVER OK");
});

/**
 * FIX: PORT MUST BE NUMBER
 */
const port = Number(process.env.PORT) || 8080;

/**
 * Start server
 */
app.listen(port, "0.0.0.0", () => {
  console.log(`SERVER STARTED ON ${port}`);
});
