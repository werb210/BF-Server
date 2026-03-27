import { createServer } from "./server/createServer";

const app = createServer();

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
