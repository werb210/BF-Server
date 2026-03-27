import { createServer } from "./server/createServer";
import { validateEnv } from "./bootstrap";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED:", err);
});

try {
  validateEnv();

  const app = createServer();

  const port = process.env.PORT || 8080;

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

} catch (err) {
  console.error("FATAL STARTUP ERROR:", err);
  process.exit(1);
}
