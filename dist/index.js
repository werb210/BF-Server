"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const env_1 = require("./config/env");
function runStartupSelfTest() {
    try {
        require("./routes");
        require("./routes/auth");
        require("./config/env");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Startup self-test failed: ${message}`);
        process.exit(1);
    }
}
console.log("BOOTING SERVER...");
(0, env_1.validateRuntimeEnvOrExit)();
runStartupSelfTest();
const port = Number(process.env.PORT || 3000);
app_1.default.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});
