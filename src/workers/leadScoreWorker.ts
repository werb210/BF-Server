// BF_SERVER_v874_MARKETING_TOOLS - refreshes lead scores every 30 minutes, silo by silo (BF, BI, SLF): contacts with
// activity in the last 2 days first, then those never scored or scored over a day ago (up to 2,000 per silo a tick).
// Ported from KS-server #48 without the Marketing add-on check: scoring is always on.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../settingsPack/common.js";
import { SCORING_SILOS, STALE_CONTACTS_SQL, scoreContacts, scoringSettings } from "../marketing/leadScoring.js";

const TICK_MS = 30 * 60_000;
export const SCORE_BATCH = 2000;

export async function runLeadScoresOnce(db: Q): Promise<{ scored: number; bySilo: Record<string, number> }> {
  let scored = 0;
  const bySilo: Record<string, number> = {};
  for (const silo of SCORING_SILOS) {
    const r = await db.query(STALE_CONTACTS_SQL, [SCORE_BATCH, silo]);
    const ids = [...new Set(r.rows.map((x: any) => String(x.id)))];
    if (!ids.length) { bySilo[silo] = 0; continue; }
    const settings = await scoringSettings(db, silo);
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) n += (await scoreContacts(db, ids.slice(i, i + 500), silo, settings)).length;
    bySilo[silo] = n;
    scored += n;
  }
  return { scored, bySilo };
}

export function startLeadScoreWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("lead_scores", async () => {
    const out = await runLeadScoresOnce(pool as unknown as Q);
    if (out.scored) console.log("[lead-scores] refreshed", out.bySilo);
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  const kickoff = setTimeout(() => { void tick(); }, 5 * 60_000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
