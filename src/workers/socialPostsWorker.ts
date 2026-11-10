// BF_SERVER_v937_SOCIAL_POSTING - publishes scheduled social posts every minute (one instance per tick).
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { publishDue } from "../social/service.js";

export function startSocialPostsWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("social_posts", async () => {
    try {
      const n = await publishDue(pool as any);
      if (n) console.log(JSON.stringify({ event: "social_posts_published", count: n }));
    } catch (e) {
      console.error("[social-posts] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, 60_000);
  void tick();
  return { stop: () => clearInterval(timer) };
}
