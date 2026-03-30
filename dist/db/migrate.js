"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const migrationRunner_1 = require("./migrationRunner");
async function runMigrations() {
    await (0, migrationRunner_1.runMigrations)();
}
