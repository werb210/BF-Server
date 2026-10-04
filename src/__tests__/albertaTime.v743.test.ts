// BF_SERVER_ALBERTA_TIME_v743
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALBERTA_TZ } from "../lib/albertaTime.js";
import { albertaTime } from "../services/clientBooking.js";
import { inviteText } from "../services/meetingRooms.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "__tests__") walk(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("Alberta time is UTC-6 all year", () => {
  it("uses a zone that is UTC-6 in summer and winter, whatever time-zone data the machine has", () => {
    expect(ALBERTA_TZ).toBe("America/Regina");
    expect(albertaTime(2026, 7, 15, 9).toISOString()).toBe("2026-07-15T15:00:00.000Z");
    expect(albertaTime(2026, 12, 7, 9).toISOString()).toBe("2026-12-07T15:00:00.000Z");
    expect(albertaTime(2027, 1, 18, 17).toISOString()).toBe("2027-01-18T23:00:00.000Z");
  });
  it("a December meeting invite shows the time the meeting was booked for", () => {
    const text = inviteText({ title: "T", code: "123456", slug: "s", starts_at: "2026-12-07T15:00:00Z" });
    expect(text).toContain("9:00");
    expect(text).toContain("(Alberta time)");
  });
  it("no server code still assumes America/Edmonton clock changes", () => {
    const hits = walk("src").filter((p) => readFileSync(p, "utf8").includes("America/Edmonton"));
    expect(hits).toEqual([]);
  });
});
