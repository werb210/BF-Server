import "dotenv/config";
import { createServer } from "./server/createServer";

const app = createServer();

const port = Number(process.env.PORT) || 8080;

console.log("BOOT: START");
console.log("BOOT: LISTENING ON", port);

app.listen(port, "0.0.0.0", () => {
  console.log(`SERVER RUNNING ON ${port}`);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err);
  process.exit(1);
});
