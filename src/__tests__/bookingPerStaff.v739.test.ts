// BF_SERVER_BOOKING_PER_STAFF_v739
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { slugOf } from "../routes/clientBooking.js";
describe("per-advisor booking links", () => {
  it("names each link after the advisor's first name", () => {
    expect(slugOf("Todd", "todd.w@boreal.financial")).toBe("todd");
    expect(slugOf(null, "andrew.p@boreal.financial")).toBe("andrew");
  });
  it("the public API looks up one advisor and never lists the team", () => {
    const r = readFileSync("src/routes/clientBooking.ts", "utf8");
    expect(r).toContain('router.get("/staff/:slug"');
    expect(r).not.toContain('router.get("/staff",');
  });
});
