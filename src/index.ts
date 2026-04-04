import app from "./app";
import { getEnv } from "./config/env";

function runStartupSelfTest() {
  try {
    require("./routes");
    require("./routes/auth");
    require("./config/env");
    getEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Startup self-test failed: ${message}`);
    process.exit(1);
  }
}

console.log("BOOTING SERVER...");
runStartupSelfTest();

const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
