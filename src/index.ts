import "./env";
import { createServer } from "./server/createServer";
import { assertRequiredEnv, assertSingleServerStart } from "./server/runtimeGuards";

assertRequiredEnv();
assertSingleServerStart();

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

console.log("BOOT START");

const app = createServer();

try {
  const port = process.env.PORT || 8080;
  const listenPort = typeof port === "string" ? Number(port) : port;

  if (process.env.NODE_ENV !== "test") {
    app.listen(listenPort, "0.0.0.0", () => {
      console.log(`Server running on ${port}`);
    });
  }
} catch (err) {
  console.error("BOOT FAILURE", err);
}

export { app };
