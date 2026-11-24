// BF_SERVER_QUICK_CALL_NAMES_v1 - colleagues show by name on internal calls, never as a user id.
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string, params: any[]) => {
  if (/FROM users WHERE id = \$1/.test(sql) && params[0] === "00000000-0000-0000-0000-000000000099") return { rows: [{ first_name: "Todd", last_name: "Werboweski", email: "t@x" }] };
  if (/FROM users/.test(sql) && /direct_number/.test(sql) && params[0] === "8254511768") return { rows: [{ first_name: "Todd", last_name: "Werboweski", email: "t@x" }] };
  return { rows: [] };
}) } }));

import { withDisplayNames } from "../voice/conferenceService.js";
import { resolveDisplayName } from "../modules/voice/callerDisplay.js";
import { pool } from "../db.js";

describe("participant names", () => {
  it("staff by name; unknown numbers formatted", async () => {
    const out = await withDisplayNames([
      { kind: "staff", identity: "00000000-0000-0000-0000-000000000099", phone_number: null },
      { kind: "pstn", identity: null, phone_number: "+15195550100" },
    ]);
    expect(out[0]!.display_name).toBe("Todd Werboweski");
    expect(out[1]!.display_name).not.toMatch(/^0{8}-/);
  });
  it("a colleague's direct line names them", async () => {
    expect(await resolveDisplayName(pool as any, "+18254511768")).toBe("Todd Werboweski");
  });
});
