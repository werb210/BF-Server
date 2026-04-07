"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = require("./app");
const port = Number(process.env.PORT) || 8080;
const app = (0, app_1.createApp)();
app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
});
