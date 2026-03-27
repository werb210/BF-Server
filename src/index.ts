console.log("BOOT: index.ts executing");

import { createServer } from "./server/createServer";

try {
  console.log("BOOT: creating server");

  const app = createServer();

  console.log("BOOT: server created");

  const port = process.env.PORT || 8080;

  app.listen(port, () => {
    console.log(`Server running on ${port}`);
  });

} catch (err) {
  console.error("FATAL STARTUP ERROR:", err);
  process.exit(1);
}
