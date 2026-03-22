import express from "express";
import { registerRoutes } from "./routeRegistry";
import { requestContextMiddleware } from "./middleware/requestContext";
import { corsMiddleware } from "./middleware/cors";
import { notFound } from "./middleware/notFound";
import { errorHandler } from "./middleware/errorHandler";
import { validateStartup } from "./startup/validateStartup";

const app = express();

// ===============================
// VALIDATE ENV (FIRST)
// ===============================
validateStartup();

// ===============================
// CORE MIDDLEWARE
// ===============================
app.use(express.json());
app.use(requestContextMiddleware);
app.use(corsMiddleware);

// ===============================
// HEALTH (ALWAYS FIRST ROUTE)
// ===============================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ===============================
// API ROUTES
// ===============================
registerRoutes(app);

// ===============================
// NOT FOUND (AFTER ROUTES)
// ===============================
app.use(notFound);

// ===============================
// ERROR HANDLER (LAST)
// ===============================
app.use(errorHandler);

// ===============================
// START SERVER (LAST)
// ===============================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
