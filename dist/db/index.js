import { deps } from "../system/deps.js";
export async function runQuery(text, params) {
    if (!deps.db.ready) {
        throw Object.assign(new Error("DB_NOT_READY"), { status: 503 });
    }
    return deps.db.client.query(text, params);
}
