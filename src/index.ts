import { app } from "./app";

export default app;

if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT) || 8080;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}
