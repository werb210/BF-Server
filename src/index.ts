import { createApp } from "./app";

function validateEnv() {
  if (!process.env.PORT) process.env.PORT = "8080";
}

async function start() {
  validateEnv();

  const app = createApp();

  const port = Number(process.env.PORT);

  app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on ${port}`);
  });
}

start();
