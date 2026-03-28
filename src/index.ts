import "./env";
import { createServer } from "./server/createServer";

const app = createServer();

const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, "0.0.0.0", () => {
  console.log("SERVER STARTED");
  console.log(`Server running on ${PORT}`);
});
