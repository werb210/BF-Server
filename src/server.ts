import { createApp } from "./app.js";
import { markReady } from "./startupState.js";

const PORT = Number(process.env.PORT) || 8080;
const app = createApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BF-Server running on port ${PORT}`);
  markReady();
});
