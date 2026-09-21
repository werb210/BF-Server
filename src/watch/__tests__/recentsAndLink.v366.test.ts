// BF_SERVER_WATCH_RECENTS_SHAPE_v366 / BF_SERVER_WATCH_LINK_SLIDING_v366
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const data = readFileSync(join(__dirname, "..", "dataRoutes.ts"), "utf8");
const auth = readFileSync(join(__dirname, "..", "authRoutes.ts"), "utf8");

describe("Watch recent calls decode on the Watch", () => {
  it("sends the direction words the Watch understands", () => {
    expect(data).toContain("WHEN cl.direction = 'inbound' THEN 'incoming'");
    expect(data).toContain("ELSE 'outgoing' END AS direction");
    expect(data).toContain("THEN 'missed'");
  });
  it("sends times without milliseconds and pages on the exact timestamp", () => {
    expect(data).toContain(`'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "occurredAt"`);
    expect(data).toContain("new Date(items.at(-1).cursorAt).toISOString()");
  });
  it("always sends a number and skips calls with none", () => {
    expect(data).toContain("CASE WHEN cl.direction = 'inbound' THEN NULLIF(TRIM(cl.from_number), '')");
    expect(data).toContain("NULLIF(TRIM(cl.to_number), '')) IS NOT NULL");
  });
});

describe("a Watch in use stays linked", () => {
  it("every refresh extends the 30-day window", () => {
    expect(auth).toContain("refresh_expires_at=now()+interval '30 days' -- BF_SERVER_WATCH_LINK_SLIDING_v366");
  });
});
