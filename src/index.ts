import { createApp } from "./app";
import { getEnv } from "./config/env";

const { PORT } = getEnv();

const app = createApp();

app.listen(Number(PORT), () => {
  console.log(`Server running on ${PORT}`);
});
