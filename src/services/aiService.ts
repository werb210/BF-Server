import { dbQuery } from "../db";
import type { AiKnowledge } from "../models/aiKnowledge";

export async function fetchRelevantKnowledge(query: string): Promise<AiKnowledge[]> {
  const knowledge = await dbQuery<AiKnowledge>(
    `select id, title, content, source_type, created_at
     from ai_knowledge
     where content ilike $1
     order by created_at desc
     limit 5`,
    [`%${query}%`]
  );

  return knowledge.rows;
}
