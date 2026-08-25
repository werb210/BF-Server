// BF_SERVER_SEED_NOTIF_v60 - the seeded admin matched every staff fan-out and
// nobody signs in as it, so every notification it received was unread by
// construction.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/services/notifications/notifyAllStaff.ts", "utf8");
const VOICE = fs.readFileSync("src/routes/voiceCalls.ts", "utf8");

describe("the seeded admin is not a notification recipient", () => {
  // BF_SERVER_SEEDNOTIF_BOTH_ADMINS_v84
  // v60 excluded SEEDED_ADMIN_ID with a single-parameter comparison. seed.ts
  // defines TWO seeded admins and the second was never added, so every inbound
  // SMS fan-out went to ...100 instead. Measured on the live table: 1,842 of
  // 2,204 notifications - 84% of everything the system has ever raised - were
  // addressed to accounts nobody signs in as, including client replies on live
  // seven-figure applications. v80 widened the exclusion to an array, which is
  // what these assertions now pin.
  it("is excluded from the staff query", () => {
    expect(SRC).toContain("AND id::text <> ALL($2::text[])");
    expect(SRC).toContain("[silo, [SEEDED_ADMIN_ID, SEEDED_ADMIN2_ID]]");
  });

  it("uses the shared constants, not repeated literals", () => {
    expect(SRC).toContain("SEEDED_ADMIN_ID");
    expect(SRC).toContain("SEEDED_ADMIN2_ID");
    expect(SRC).not.toContain('"00000000-0000-0000-0000-000000000099"');
    expect(SRC).not.toContain('"00000000-0000-0000-0000-000000000100"');
  });
});

describe("the account itself survives", () => {
  it("voiceCalls still surfaces browser-dialer calls owned by it", () => {
    expect(VOICE).toContain("00000000-0000-0000-0000-000000000099");
    expect(VOICE).toContain("BF_SERVER_OUTBOUND_SEEDED_OWNER_v1");
  });
});
