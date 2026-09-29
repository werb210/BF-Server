// BF_SERVER_DIRECT_LINES_v688
import { describe, expect, it } from "vitest";
import { directNumberFor, e164, staffForDirectNumber } from "../voice/directLines.js";
import { readFileSync } from "node:fs";
import { mainLineNumber, callerIdForUser } from "../voice/directLines.js";

const q = (rows: any[]) => ({ query: async () => ({ rows }) });

describe("v688 staff direct lines", () => {
  it("normalises numbers", () => {
    expect(e164("+1 (825) 451-1768")).toBe("+18254511768");
    expect(e164("8254511768")).toBe("+18254511768");
    expect(e164("18664318939")).toBe("+18664318939");
    expect(e164("451-1768")).toBeNull();
    expect(e164(undefined)).toBeNull();
  });
  it("finds the staff member a direct number belongs to, ringing their Twilio identity", async () => {
    expect(await staffForDirectNumber(q([{ user_id: "u1", first_name: "Andrew", last_name: "Polturak", twilio_identity: "u1" }]), "+1 780 555 0100"))
      .toEqual({ userId: "u1", identity: "u1", name: "Andrew Polturak" });
    expect(await staffForDirectNumber(q([{ user_id: "u2", first_name: "Todd", last_name: null, twilio_identity: null }]), "8254511768"))
      .toEqual({ userId: "u2", identity: "u2", name: "Todd" });
    expect(await staffForDirectNumber(q([]), "+18664318939")).toBeNull();
    expect(await staffForDirectNumber(q([]), "not a number")).toBeNull();
  });
  it("uses a staff member's direct number as their caller ID", async () => {
    expect(await directNumberFor(q([{ direct_number: "(825) 451-1768" }]), "u2")).toBe("+18254511768");
    expect(await directNumberFor(q([{ direct_number: null }]), "u3")).toBeNull();
    expect(await directNumberFor(q([]), null)).toBeNull();
  });
});

describe("v688b: caller ID and receptionist reach", () => {
  it("staff without a direct number call out as the 866 main line", async () => {
    const prev = process.env.TWILIO_MAIN_LINE_NUMBER; delete process.env.TWILIO_MAIN_LINE_NUMBER;
    expect(mainLineNumber()).toBe("+18666318939");
    expect(await callerIdForUser({ query: async () => ({ rows: [{ direct_number: null }] }) }, "u3")).toBe("+18666318939");
    expect(await callerIdForUser({ query: async () => ({ rows: [{ direct_number: "5874165992" }] }) }, "u1")).toBe("+15874165992");
    if (prev !== undefined) process.env.TWILIO_MAIN_LINE_NUMBER = prev;
  });
  it("outbound, add-a-caller and transfer all use callerIdForUser; the receptionist counts the dialler app", () => {
    expect(readFileSync("src/routes/voiceCalls.ts", "utf8")).toContain("await callerIdForUser(pool, userId)");
    expect(readFileSync("src/routes/voiceMidCall.ts", "utf8").split("fromNumber: await callerIdForUser(").length - 1).toBe(2);
    expect(readFileSync("src/routes/reception.ts", "utf8")).toContain("FROM staff_device_credentials dc");
  });
  it("rejection emails give the 866 and lead alerts take their number from settings", () => {
    expect(readFileSync("src/services/rejectionNotice.ts", "utf8")).not.toContain("451-1768");
    const c = readFileSync("src/modules/ai/confidence.routes.ts", "utf8");
    expect(c).not.toMatch(/587.?888.?1837/);
    expect(c).toContain("process.env.LEAD_ALERT_SMS_TO");
  });
});

describe("v688c: no staff cell numbers in code", () => {
  it("lead alerts and seeds read settings", () => {
    expect(readFileSync("src/routes/creditReadiness.ts", "utf8")).toContain("if (leadAlertTo) await retry(");
    expect(readFileSync("src/db/seed.ts", "utf8")).toContain("process.env.BOOTSTRAP_ADMIN_PHONE");
    for (const f of ["src/routes/creditReadiness.ts", "src/routes/marketing.ts", "src/db/seed.ts", "src/modules/ai/confidence.routes.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/587.?888.?1837|780.?264.?8467/);
    }
  });
});
