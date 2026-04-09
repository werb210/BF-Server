import { dbQuery } from "../db.js";
export async function fetchRelevantKnowledge(query) {
    const knowledge = await dbQuery(`select id, title, content, source_type, created_at
     from ai_knowledge
     where content ilike $1
     order by created_at desc
     limit 5`, [`%${query}%`]);
    return knowledge.rows;
}
