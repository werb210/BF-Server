"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const migrations_1 = require("../migrations");
async function runMigrations() {
    await (0, migrations_1.runMigrations)();
}
