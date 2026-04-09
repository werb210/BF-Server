import app from "./app";

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BF-Server running on port ${PORT}`);
});
