import app from "./app";

console.log("BOOTING SERVER...");
const port = process.env.PORT || 3000;
const listenPort = Number(port);

app.listen(listenPort, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
