"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const init_1 = require("./db/init");
const PORT = process.env.PORT || 8080;
void (async () => {
    try {
        await (0, init_1.initDb)();
    }
    catch (err) {
        console.error("DB INIT FAILED:", err);
    }
    const app = (0, app_1.createApp)();
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
})();
