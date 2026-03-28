import { createServer } from "./server/createServer";

const app = createServer();

const port = Number(process.env.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
