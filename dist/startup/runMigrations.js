"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function runMigrations(pool) {
    const migrationsDir = path_1.default.join(process.cwd(), "server/migrations");
    if (!fs_1.default.existsSync(migrationsDir)) {
        return;
    }
    const files = fs_1.default
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort();
    for (const file of files) {
        const sql = fs_1.default.readFileSync(path_1.default.join(migrationsDir, file), "utf8");
        try {
            await pool.runQuery(sql);
            console.log(`migration_applied: ${file}`);
        }
        catch (err) {
            console.warn(`migration_skipped_or_failed: ${file}`, err);
        }
    }
}
