import { createServer } from "./createServer";

const app = createServer();
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
