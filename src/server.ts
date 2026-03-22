import express from "express";
import lenders from "./routes/lenders";
import lenderProducts from "./routes/lenderProducts";
import health from "./platform/healthRoutes";
import readiness from "./routes/readiness";

const app = express();
app.use(express.json());

app.use("/lenders", lenders);
app.use("/lenderProducts", lenderProducts);
app.use("/health", health);
app.use("/readiness", readiness);

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});
