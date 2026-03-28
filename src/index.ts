import { createServer } from "./server/createServer";

const app = createServer();

const port = process.env.PORT || "8080";

app.listen(Number(port), "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
