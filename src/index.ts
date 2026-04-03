import { createApp } from "./app";

const PORT = Number(process.env.PORT) || 8080;

const app = createApp();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down.");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down.");
  server.close(() => process.exit(0));
});
