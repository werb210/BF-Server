import { pool } from "../db.js";
import { deps } from "./deps.js";
export async function initDependencies() {
    let success = false;
    for (let i = 0; i < 3; i++) {
        try {
            await pool.query("SELECT 1");
            success = true;
            break;
        }
        catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    deps.db.ready = success;
}
