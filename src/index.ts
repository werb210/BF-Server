console.log("ENTRYPOINT: file loaded");

import { createServer } from "./server/createServer";

console.log("ENTRYPOINT: imports completed");

try {
  console.log("ENTRYPOINT: creating server");

  const app = createServer();

  console.log("ENTRYPOINT: server created");

  const port = process.env.PORT || 8080;

  console.log("ENTRYPOINT: starting listen");

  app.listen(port, () => {
    console.log("ENTRYPOINT: server listening");
    console.log(`Server running on ${port}`);
  });

} catch (err) {
  console.error("FATAL STARTUP ERROR:", err);
  process.exit(1);
}
