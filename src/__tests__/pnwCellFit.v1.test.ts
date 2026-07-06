// BF_SERVER_PNW_CELL_FIT_v1 - PNW PDF cells auto-shrink + ellipsize long values
// so they never overflow into the next column (the reference Address was
// colliding with the Cell Phone). Verified by rendering a PNW with a long
// reference address and confirming it produces a valid PDF.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPnwPdfFromData } from "../signnow/pnwPdfBuilder.js";

const builder = readFileSync(join(process.cwd(), "src", "signnow", "pnwPdfBuilder.ts"), "utf-8");

describe("PNW cell fitting", () => {
  it("the cell renderer measures width and shrinks/ellipsizes to fit", () => {
    expect(builder).toContain("BF_SERVER_PNW_CELL_FIT_v1");
    expect(builder).toContain("widthOfTextAtSize");
    expect(builder).toContain("sz -= 0.5");
    expect(builder).toContain('val + "..."');
  });

  it("renders a valid PDF even with an overflowing reference address", async () => {
    const bytes = await buildPnwPdfFromData({
      fields: {
        primary_name: "Lorne Benjamin",
        ref1_name: "Berisford Benjamin",
        ref1_rel: "Parent",
        ref1_address: "21 Overlea Blvd, Suite 1204, Toronto, On, M4S 1V2",
        ref1_phone: "4164092890",
      },
    });
    expect(bytes.length).toBeGreaterThan(1000);
    // PDF magic header
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  });
});
