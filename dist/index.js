"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const createServer_1 = require("./server/createServer");
const app = (0, createServer_1.createServer)();
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});
