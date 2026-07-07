// BF_SERVER_MARKETING_KNOWLEDGE_v1 - reconcile Maya knowledge with marketing content:
// marketing_template rows (email/SMS messaging) and collateral_assets (uploaded
// marketing files). Ingests anything not yet in ai_knowledge and prunes rows whose
// source no longer exists. Safe to run repeatedly. Mirrors productIngest.service.
import { embedAndStore } from "./knowledge.service.js";
import { getStorage } from "../../lib/storage/index.js";

type Queryable = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

type TemplateRow = { id: string; channel: string | null; name: string | null; subject: string | null; body: string | null };
type CollateralRow = { id: string; name: string | null; audience: string | null; doc_type: string | null; blob_name: string | null; content_type: string | null };

function toTemplateKnowledge(row: TemplateRow): string {
  const parts = [
    `Marketing template: ${row.name ?? "Untitled"}`,
    `Channel: ${row.channel ?? "N/A"}`,
  ];
  if (row.subject) parts.push(`Subject: ${row.subject}`);
  parts.push(`Body: ${row.body ?? ""}`);
  return parts.join("\n");
}

async function ingestTemplate(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query<TemplateRow>(
    `select id, channel, name, subject, body from marketing_template where id = $1 limit 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return false;
  const text = toTemplateKnowledge(row);
  if (!text.trim()) return false;
  await embedAndStore(db, text, "marketing_template", row.id, row.name ?? `Template ${row.id}`);
  return true;
}

async function ingestCollateral(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query<CollateralRow>(
    `select id, name, audience, doc_type, blob_name, content_type from collateral_assets where id = $1 limit 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row || !row.blob_name) return false;
  let text = "";
  try {
    const got = await getStorage().get(row.blob_name);
    if (got?.buffer?.length) {
      const { extractTextFromBuffer } = await import("../../ai/embeddingService.js");
      const raw = await extractTextFromBuffer(got.buffer, row.content_type ?? "");
      text = (raw || "").slice(0, 200_000).trim();
    }
  } catch {
    text = "";
  }
  const header = `Marketing collateral: ${row.name ?? "Untitled"}${row.audience ? ` (audience: ${row.audience})` : ""}`;
  const content = text ? `${header}\n${text}` : header;
  await embedAndStore(db, content, "marketing_collateral", row.id, row.name ?? `Collateral ${row.id}`);
  return true;
}

// Reconcile Maya knowledge with marketing_template + collateral_assets.
export async function reconcileMarketingKnowledge(
  db: Queryable,
): Promise<{ ingested: number; pruned: number }> {
  let ingested = 0;
  let pruned = 0;

  const missingTpl = await db.query<{ id: string }>(
    `select t.id from marketing_template t
      where not exists (
        select 1 from ai_knowledge k where k.source_type like 'marketing_template%' and k.source_id = t.id::text
      )`,
  );
  for (const row of missingTpl.rows) {
    try { if (await ingestTemplate(db, row.id)) ingested += 1; } catch { /* skip bad row */ }
  }

  const missingCol = await db.query<{ id: string }>(
    `select c.id from collateral_assets c
      where not exists (
        select 1 from ai_knowledge k where k.source_type like 'marketing_collateral%' and k.source_id = c.id::text
      )`,
  );
  for (const row of missingCol.rows) {
    try { if (await ingestCollateral(db, row.id)) ingested += 1; } catch { /* skip bad row */ }
  }

  const pruneTpl = await db.query<{ id: string }>(
    `delete from ai_knowledge where source_type like 'marketing_template%'
       and source_id is not null
       and not exists (select 1 from marketing_template t where t.id::text = ai_knowledge.source_id)
     returning id`,
  );
  pruned += pruneTpl.rows.length;

  const pruneCol = await db.query<{ id: string }>(
    `delete from ai_knowledge where source_type like 'marketing_collateral%'
       and source_id is not null
       and not exists (select 1 from collateral_assets c where c.id::text = ai_knowledge.source_id)
     returning id`,
  );
  pruned += pruneCol.rows.length;

  return { ingested, pruned };
}
