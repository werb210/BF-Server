"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const app_1 = require("./app");
const deps_1 = require("./system/deps");
exports.app = (0, app_1.createApp)(deps_1.deps);
if (require.main === module) {
    const PORT = process.env.PORT || 8080;
    exports.app.listen(PORT, () => {
        console.log(`Server listening on ${PORT}`);
    });
}
exports.default = exports.app;
