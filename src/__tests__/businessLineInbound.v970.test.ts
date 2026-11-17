// BF_SERVER_v970_BUSINESS_LINE_INBOUND
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSiloLineCache, siloForLineNumber } from "../voice/directLines.js";
import { clearSavedKsLine, isKsVoiceNumber, ksVoiceEnabled, refreshKsLine } from "../modules/ks/ksPhone.js";
import { defaultBorealMenu } from "../phoneMenu/menu.js";

function db(settings: Record<string, string>) {
  return { query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^SELECT value FROM settings/.test(sql)) { const v = settings[String(params[0])]; return { rows: v ? [{ value: v }] : [] }; }
    return { rows: [] };
  }) };
}
beforeEach(() => { clearSiloLineCache(); clearSavedKsLine(); delete process.env.KS_VOICE_NUMBER; });

describe("a call to a business's own line", () => {
  it("knows which business a number belongs to, however it is written", async () => {
    const q = db({ "silo_line.BI": "+18885550142", "silo_line.KS": "+18885550177" });
    expect(await siloForLineNumber(q, "+18885550142")).toBe("BI");
    expect(await siloForLineNumber(q, "(888) 555-0177")).toBe("KS");
    expect(await siloForLineNumber(q, "+18666318939")).toBeNull();
    expect(await siloForLineNumber(q, "")).toBeNull();
  });
  it("the saved Keystone line turns the Keystone menu on with no server variable; the variable still wins", async () => {
    expect(ksVoiceEnabled()).toBe(false);
    expect(await refreshKsLine(db({ "silo_line.KS": "+18885550177" }))).toBe("+18885550177");
    expect(ksVoiceEnabled()).toBe(true);
    expect(isKsVoiceNumber("+18885550177")).toBe(true);
    process.env.KS_VOICE_NUMBER = "+18885550199";
    expect(isKsVoiceNumber("+18885550199")).toBe(true);
    expect(isKsVoiceNumber("+18885550177")).toBe(false);
  });
  it("the Insurance greeting names Boreal Risk Management, never the group menu, and finds the Risk Management option", async () => {
    const { BI_LINE_PHRASES, riskManagementOption } = await import("../routes/reception.js");
    expect(BI_LINE_PHRASES.open).toContain("Boreal Risk Management");
    expect(BI_LINE_PHRASES.open).toContain("may be recorded");
    expect(BI_LINE_PHRASES.open).not.toMatch(/Financial|Group of Companies/);
    expect(riskManagementOption(defaultBorealMenu().options)?.label).toBe("Boreal Risk Management");
    expect(riskManagementOption([])).toBeNull();
  });
});
