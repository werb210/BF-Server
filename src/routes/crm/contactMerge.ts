// BF_SERVER_CONTACT_MERGE_v1
// A real contact merge. The pre-existing /contacts/dedupe-merge only archives duplicates
// with NO activity, and only finds them by exact email or exact phone - which misses every
// real duplicate in this database (Mike Cotic, Juergen Zischler, Wayne Beamish all differ
// on BOTH email and phone, and all have activity on both records).
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = Router({ mergeParams: true });
router.use(requireAuth);

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

// Every table with a contact_id column, discovered at runtime rather than hardcoded - a
// hardcoded list silently rots the moment someone adds a table, and a merge that misses a
// table orphans that history.
async function contactRefTables(): Promise<string[]> {
  const r = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'contact_id'
        AND table_name <> 'contacts'
        AND data_type = 'uuid'
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

// BF_SERVER_CONTACT_MERGE_UNIQUE_v1
// A blind `UPDATE t SET contact_id = survivor WHERE contact_id = loser` explodes the moment
// BOTH contacts have a row in a table with a UNIQUE constraint that includes contact_id.
// Live failure: merging the two Amir Ghanem records returned
//   duplicate key value violates unique constraint "marketing_sequence_enrollments_..."
// because both were enrolled in the SAME marketing sequence, and that table is
// UNIQUE (sequence_id, contact_id). ad_attribution is UNIQUE (contact_id, gclid) and is the
// same landmine. Discovered at runtime from pg_index rather than hardcoded, so a new table
// with a new unique constraint cannot silently reintroduce this.
// BF_SERVER_CONTACT_MERGE_COLS_FIX_v1
// pg_attribute.attname is Postgres type `name`, so array_agg(attname) yields name[]
// (OID 1003). node-pg registers NO array parser for that OID, so it returns the raw
// literal "{contact_id,sequence_id}" as a STRING, not a JS array -- and .filter() on it
// threw `cols.filter is not a function`, 500ing every merge. Cast to text[] (OID 1009),
// which node-pg does parse, and defensively parse the literal if a driver ever regresses.
function toColumnArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    return v.replace(/^\{|\}$/g, "").split(",").map((c) => c.replace(/^"|"$/g, "").trim()).filter(Boolean);
  }
  return [];
}

async function uniqueColumnSets(table: string): Promise<string[][]> {
  const r = await pool.query<{ cols: unknown }>(
    `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE i.indisunique
        AND i.indpred IS NULL
        AND i.indexprs IS NULL
        AND n.nspname = 'public'
        AND t.relname = $1
      GROUP BY i.indexrelid
     HAVING 'contact_id' = ANY(array_agg(a.attname::text))`,
    [table],
  );
  return r.rows.map((x) => toColumnArray(x.cols)).filter((c) => c.length > 0);
}

// Candidates for ONE contact. Exact email / exact last-10 phone, plus a pure-SQL name match,
// which is the only thing that finds a person who used a different address and a different
// number on two occasions.
router.get(
  "/:id/duplicate-candidates",
  safeHandler(async (req: any, res: any) => {
    const silo = resolveSiloFromRequest(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.json({ ok: true, data: [] });

    const { rows } = await pool.query(
      `WITH me AS (
         SELECT id, name, email, phone, company_id
           FROM contacts WHERE id = $1::uuid AND silo = $2
       )
       SELECT c.id, c.name, c.email, c.phone, c.created_at,
              co.name AS company_name,
              -- why we think it is the same person, so staff are never asked to trust a
              -- black box
              (CASE WHEN c.email IS NOT NULL AND me.email IS NOT NULL
                     AND lower(trim(c.email)) = lower(trim(me.email)) THEN 'email' END) AS match_email,
              (CASE WHEN c.phone IS NOT NULL AND me.phone IS NOT NULL
                     AND right(regexp_replace(c.phone,'[^0-9]','','g'),10)
                       = right(regexp_replace(me.phone,'[^0-9]','','g'),10) THEN 'phone' END) AS match_phone,
              -- Trigram similarity is NOT available: Azure Postgres does not allow-list
              -- that extension. bf_same_person_name() is pure SQL (see the migration).
              bf_same_person_name(c.name, me.name) AS match_name,
              (SELECT count(*)::int FROM applications a WHERE a.contact_id = c.id) AS applications,
              (SELECT count(*)::int FROM call_logs cl WHERE cl.crm_contact_id = c.id) AS calls,
              (SELECT count(*)::int FROM communications_messages m WHERE m.contact_id = c.id) AS messages
         FROM contacts c
         CROSS JOIN me
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.silo = $2
          AND c.id <> me.id
          AND c.merged_into_id IS NULL
          AND coalesce(c.status,'active') <> 'archived'
          AND (
            (c.email IS NOT NULL AND me.email IS NOT NULL
              AND lower(trim(c.email)) = lower(trim(me.email)))
            OR (c.phone IS NOT NULL AND me.phone IS NOT NULL
              AND length(regexp_replace(me.phone,'[^0-9]','','g')) >= 10
              AND right(regexp_replace(c.phone,'[^0-9]','','g'),10)
                = right(regexp_replace(me.phone,'[^0-9]','','g'),10))
            -- the case the old preview is blind to: same human, different everything.
            -- Anchored on an exact surname match, so "Mike Cotic" finds "MICHAEL COTIC"
            -- but not "Mike Jones".
            OR bf_same_person_name(c.name, me.name)
          )
        ORDER BY (c.email IS NOT NULL) DESC, c.created_at ASC
        LIMIT 25`,
      [id, silo],
    );

    return res.json({ ok: true, data: rows });
  }),
);

// The merge. Survivor keeps its own non-empty fields and inherits anything it is MISSING
// from the losers - a merge must never destroy data that only the loser had.
router.post(
  "/merge",
  safeHandler(async (req: any, res: any) => {
    const silo = resolveSiloFromRequest(req);
    const survivorId = String(req.body?.survivorId ?? "").trim();
    const loserIds: string[] = Array.isArray(req.body?.loserIds)
      ? req.body.loserIds.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [];
    const dryRun = req.body?.dryRun === true;

    if (!survivorId || loserIds.length === 0) {
      return res.status(400).json({ ok: false, error: "survivorId and loserIds are required" });
    }
    if (loserIds.includes(survivorId)) {
      return res.status(400).json({ ok: false, error: "a contact cannot be merged into itself" });
    }

    const tables = await contactRefTables();
    const client = await pool.connect();
    const summary: Record<string, number> = {};
    const dropped: Record<string, any[]> = {};

    try {
      await client.query("BEGIN");

      const sv = await client.query(
        `SELECT * FROM contacts WHERE id = $1::uuid AND silo = $2 FOR UPDATE`,
        [survivorId, silo],
      );
      if (sv.rowCount === 0) throw new Error("survivor not found in this silo");

      for (const loserId of loserIds) {
        const lo = await client.query(
          `SELECT * FROM contacts WHERE id = $1::uuid AND silo = $2 FOR UPDATE`,
          [loserId, silo],
        );
        if (lo.rowCount === 0) throw new Error(`contact ${loserId} not found in this silo`);
        const loser = lo.rows[0];

        // Repoint every table that references the loser. Before each repoint, drop the loser
        // rows that would collide with a survivor row on a UNIQUE constraint containing
        // contact_id -- otherwise the whole merge 500s (see uniqueColumnSets above). Dropped
        // rows are snapshotted into contact_merges so the merge stays reversible.
        for (const t of tables) {
          for (const cols of await uniqueColumnSets(t)) {
            const others = cols.filter((c) => c !== "contact_id");
            const sameOthers = others.length
              ? " AND " + others.map((c) => `s.${quoteIdent(c)} IS NOT DISTINCT FROM l.${quoteIdent(c)}`).join(" AND ")
              : "";
            const d = await client.query(
              `DELETE FROM ${quoteIdent(t)} l
                WHERE l.contact_id = $2::uuid
                  AND EXISTS (SELECT 1 FROM ${quoteIdent(t)} s
                               WHERE s.contact_id = $1::uuid${sameOthers})
              RETURNING *`,
              [survivorId, loserId],
            );
            if ((d.rowCount ?? 0) > 0) {
              dropped[t] = (dropped[t] ?? []).concat(d.rows);
              summary[`${t}:deduped`] = (summary[`${t}:deduped`] ?? 0) + (d.rowCount ?? 0);
            }
          }
          const r = await client.query(
            `UPDATE ${quoteIdent(t)} SET contact_id = $1::uuid WHERE contact_id = $2::uuid`,
            [survivorId, loserId],
          );
          if ((r.rowCount ?? 0) > 0) summary[t] = (summary[t] ?? 0) + (r.rowCount ?? 0);
        }

        // call_logs uses crm_contact_id, not contact_id, so the generic sweep above misses
        // it - and calls are exactly the history a merge must not lose.
        const cl = await client.query(
          `UPDATE call_logs SET crm_contact_id = $1::uuid WHERE crm_contact_id = $2::uuid`,
          [survivorId, loserId],
        );
        if ((cl.rowCount ?? 0) > 0) summary["call_logs"] = (summary["call_logs"] ?? 0) + (cl.rowCount ?? 0);

        // Fill in anything the survivor is missing. coalesce keeps the survivor's value
        // wherever it has one.
        await client.query(
          `UPDATE contacts s SET
             email          = coalesce(nullif(trim(s.email),''), nullif(trim($2),'')),
             phone          = coalesce(nullif(trim(s.phone),''), nullif(trim($3),'')),
             first_name     = coalesce(nullif(trim(s.first_name),''), nullif(trim($4),'')),
             last_name      = coalesce(nullif(trim(s.last_name),''), nullif(trim($5),'')),
             company_id     = coalesce(s.company_id, $6::uuid),
             address_street = coalesce(nullif(trim(s.address_street),''), nullif(trim($7),'')),
             address_city   = coalesce(nullif(trim(s.address_city),''), nullif(trim($8),'')),
             address_state  = coalesce(nullif(trim(s.address_state),''), nullif(trim($9),'')),
             address_zip    = coalesce(nullif(trim(s.address_zip),''), nullif(trim($10),'')),
             dob            = coalesce(s.dob, $11::date),
             tags           = (SELECT array_agg(DISTINCT x)
                                 FROM unnest(coalesce(s.tags,'{}') || coalesce($12::text[],'{}')) AS x),
             updated_at     = now()
           WHERE s.id = $1::uuid`,
          [
            survivorId, loser.email, loser.phone, loser.first_name, loser.last_name,
            loser.company_id, loser.address_street, loser.address_city, loser.address_state,
            loser.address_zip, loser.dob, loser.tags ?? null,
          ],
        );

        // Archive the loser with a pointer, and snapshot it so a bad merge is recoverable.
        await client.query(
          `UPDATE contacts
              SET merged_into_id = $1::uuid, merged_at = now(),
                  status = 'archived', updated_at = now()
            WHERE id = $2::uuid`,
          [survivorId, loserId],
        );

        await client.query(
          `INSERT INTO contact_merges (silo, survivor_id, loser_id, moved, loser_snapshot, merged_by)
           VALUES ($1, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::uuid)`,
          [silo, survivorId, loserId, JSON.stringify(summary),
           JSON.stringify({ contact: loser, dropped }),
           req.user?.id ?? req.user?.userId ?? null],
        );
      }

      if (dryRun) {
        await client.query("ROLLBACK");
        return res.json({ ok: true, data: { dryRun: true, survivorId, loserIds, wouldMove: summary } });
      }

      await client.query("COMMIT");
      console.log("[contact-merge] merged", { survivorId, loserIds, moved: summary });
      return res.json({ ok: true, data: { survivorId, loserIds, moved: summary } });
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[contact-merge] failed", { survivorId, loserIds, message: err?.message });
      return res.status(500).json({ ok: false, error: err?.message ?? "merge_failed" });
    } finally {
      client.release();
    }
  }),
);

export default router;
