import express from "express";

const app = express();

/**
 * CRITICAL: TRUST AZURE PROXY
 */
app.set("trust proxy", true);

/**
 * FORCE ACCEPT ALL HOST HEADERS
 * (Azure sometimes forwards unexpected host values)
 */
app.use((req, res, next) => {
  req.headers.host = req.headers.host || "server.boreal.financial";
  next();
});

/**
 * HARD HEALTH ENDPOINT (TOP PRIORITY)
 */
app.get("/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

app.get("/api/_int/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

/**
 * BASIC ROOT CHECK
 */
app.get("/", (req, res) => {
  res.status(200).send("BF-SERVER OK");
});

/**
 * START SERVER
 */
const port = process.env.PORT || 8080;

app.listen(port, "0.0.0.0", () => {
  console.log(`SERVER STARTED ON ${port}`);
});
