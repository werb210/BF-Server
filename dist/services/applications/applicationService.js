import { runQuery } from "../../db.js";
export async function fetchLatestIncompleteApplication(userId) {
    const result = await runQuery(`select *
     from applications
     where owner_user_id = $1
       and lower(coalesce(pipeline_state, '')) not in ('submitted', 'funded', 'rejected')
     order by created_at desc
     limit 1`, [userId]);
    return result.rows[0] ?? null;
}
