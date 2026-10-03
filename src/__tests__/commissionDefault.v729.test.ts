// BF_SERVER_COMMISSION_DEFAULT_2PCT_v729
import { describe, it, expect, afterEach } from "vitest";
import { commissionRate } from "../services/googleDataManager.js";

afterEach(() => { delete process.env.GOOGLE_ADS_COMMISSION_RATE; });

describe("default commission", () => {
  it("is 2% unless a rate is set", () => {
    delete process.env.GOOGLE_ADS_COMMISSION_RATE;
    expect(commissionRate()).toBe(0.02);
    process.env.GOOGLE_ADS_COMMISSION_RATE = "nonsense";
    expect(commissionRate()).toBe(0.02);
  });
});
