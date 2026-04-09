import { dbQuery } from "../db.js";
export async function fetchActiveLenderCount() {
    const result = await dbQuery("select count(*)::int as count from lenders where active = true");
    return result.rows[0]?.count ?? 0;
}
