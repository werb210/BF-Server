import "dotenv/config";
import app from "./app";
import { getEnv } from "./config/env";

const port = Number(process.env.PORT ?? 8080);

getEnv();

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
