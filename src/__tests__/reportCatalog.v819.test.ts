// BF_SERVER_v819_MOBILE_REPORT
import { describe, expect, it } from "vitest";
import * as catalog from "../services/reports/catalog.js";

const entries: Array<{ key: string; title: string }> = (Object.values(catalog).find((v) => Array.isArray(v) && (v as any[]).some((e) => e && typeof e === "object" && "key" in e)) ?? []) as any;

describe("v819 report catalog", () => {
  it("has the Mobile apps card", () => {
    expect(entries.find((e) => e.key === "mobile_apps")?.title).toBe("Mobile apps");
  });
  it("lists every report once", () => {
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
