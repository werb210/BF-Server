// BF_SERVER_SEED_NOTIF_v60 - the seeded admin matched every staff fan-out and
// nobody signs in as it, so every notification it received was unread by
// construction.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/services/notifications/notifyAllStaff.ts", "utf8");
const VOICE = fs.readFileSync("src/routes/voiceCalls.ts", "utf8");

describe("the seeded admin is not a notification recipient", () => {
  it("is excluded from the staff query", () => {
    expect(SRC).toContain("AND id::text <> $2");
    expect(SRC).toContain("[silo, SEEDED_ADMIN_ID]");
  });

  it("uses the shared constant, not a repeated literal", () => {
    expect(SRC).toContain('import { SEEDED_ADMIN_ID }');
    expect(SRC).not.toContain('"00000000-0000-0000-0000-000000000099"');
  });
});

describe("the account itself survives", () => {
  it("voiceCalls still surfaces browser-dialer calls owned by it", () => {
    expect(VOICE).toContain("00000000-0000-0000-0000-000000000099");
    expect(VOICE).toContain("BF_SERVER_OUTBOUND_SEEDED_OWNER_v1");
  });
});
