// BF_SERVER_BLOCK_v561 - has the client finished their PGI application?
// Asks BI-Server (the PGI data owner) for the linked application's stage through
// the same Maya service endpoint staff use. Cached 5 minutes per application,
// because the client portal polls its thread. Unknown means "not done".
import jwt from "jsonwebtoken";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; stage: string | null }>();

export function pgiDone(stage: string | null | undefined): boolean {
  return Boolean(stage) && stage !== "new_application";
}

type Deps = { biPublicId: (applicationId: string) => Promise<string | null>; fetchStage: (biPublicId: string) => Promise<string | null>; now: () => number };

export async function pgiStageFor(applicationId: string, deps: Deps = defaultDeps): Promise<string | null> {
  const hit = cache.get(applicationId);
  if (hit && deps.now() - hit.at < TTL_MS) return hit.stage;
  let stage: string | null = null;
  try {
    const publicId = await deps.biPublicId(applicationId);
    if (publicId) stage = await deps.fetchStage(publicId);
  } catch (err: any) {
    console.warn("[pgi-stage] lookup_failed", { applicationId, message: err?.message });
  }
  cache.set(applicationId, { at: deps.now(), stage });
  return stage;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  async biPublicId(applicationId) {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ bi_public_id: string | null }>(
      `SELECT bi_public_id FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId],
    ).catch((err) => { console.warn("[pgi-stage] link_read_failed", err?.message); return { rows: [] as { bi_public_id: string | null }[] }; });
    return r.rows[0]?.bi_public_id ?? null;
  },
  async fetchStage(biPublicId) {
    const base = (process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net").replace(/\/+$/, "");
    const token = jwt.sign({ kind: "service", source: "maya-service" }, process.env.JWT_SECRET || "", { expiresIn: "5m" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(`${base}/api/v1/bi/maya/staff/pgi-readiness`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ public_id: biPublicId }),
        signal: controller.signal,
      });
      const body: any = await resp.json().catch(() => null);
      return resp.ok && body?.ok ? (body.result?.stage ?? null) : null;
    } finally {
      clearTimeout(timer);
    }
  },
};

export function __clearPgiStageCache(): void {
  cache.clear();
}
