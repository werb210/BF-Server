import { createApp } from "./app.js";

const app = createApp();
const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER STARTED ON ${PORT}`);
});
