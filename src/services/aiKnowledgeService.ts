import { dbQuery } from "../db.js";
import type { AiKnowledgeSourceType } from "../models/aiKnowledge.js";
import { logInfo } from "../observability/logger.js";

type SaveKnowledgeInput = {
  title: string;
  content: string;
  sourceType?: AiKnowledgeSourceType;
};

export async function saveKnowledge({
  title,
  content,
  sourceType = "internal",
}: SaveKnowledgeInput): Promise<void> {
  await dbQuery(
    `insert into ai_knowledge (title, content, source_type)
     values ($1, $2, $3)`,
    [title, content, sourceType]
  );

  logInfo("audit_ai_knowledge_saved", {
    title,
    sourceType,
    contentLength: content.length,
  });
}
