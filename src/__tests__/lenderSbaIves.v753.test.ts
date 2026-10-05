// BF_SERVER_LENDER_SBA_IVES_v753
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseLenderSba, readLenderSba, saveLenderSba } from "../services/lenders/lenderSba.js";

describe("offers SBA + IVES details", () => {
  it("a lender that offers SBA must give the three 4506-C line 5a fields", () => {
    expect(parseLenderSba({ offersSba: true }).errors).toHaveLength(3);
    const ok = parseLenderSba({ offersSba: true, ivesParticipantName: " Acme SBA ", ivesParticipantId: "12345", ivesSorMailboxId: "SOR-9", ivesCity: "Austin" });
    expect(ok.errors).toEqual([]);
    expect(ok.value).toMatchObject({ offersSba: true, ivesParticipantName: "Acme SBA", ivesParticipantId: "12345", ivesSorMailboxId: "SOR-9", ivesCity: "Austin", ivesZip: "" });
  });
  it("a lender that does not offer SBA needs nothing else, and unanswered stays unanswered", () => {
    expect(parseLenderSba({ offersSba: false })).toMatchObject({ errors: [], value: { offersSba: false } });
    expect(parseLenderSba({ offers_sba: "no" }).value.offersSba).toBe(false);
    expect(parseLenderSba({}).value.offersSba).toBeNull();
  });
  it("saves to lenders.offers_sba and the ives_* columns, then reads them back", async () => {
    let stored: any = { offers_sba: null };
    const q = async (sql: string, params: unknown[]) => {
      if (/^UPDATE lenders SET offers_sba = \$2, ives_participant_name = \$3/.test(sql)) {
        const cols = ["offers_sba", "ives_participant_name", "ives_participant_id", "ives_sor_mailbox_id", "ives_street", "ives_city", "ives_state", "ives_zip"];
        cols.forEach((c, i) => { stored[c] = params[i + 1]; });
        return { rows: [{ id: params[0] }] };
      }
      if (/^\s*SELECT offers_sba, ives_participant_name/.test(sql)) return { rows: [stored] };
      throw new Error("unexpected sql " + sql);
    };
    const { value } = parseLenderSba({ offersSba: true, ivesParticipantName: "Acme", ivesParticipantId: "1", ivesSorMailboxId: "M" });
    const saved = await saveLenderSba("l1", value, q);
    expect(saved).toMatchObject({ offersSba: true, ivesParticipantName: "Acme", ivesParticipantId: "1", ivesSorMailboxId: "M", ivesStreet: "" });
    expect(await readLenderSba("l1", q)).toEqual(saved);
  });
  it("routes exist for staff and for the lender, and a lender saying no gets no 4506-C", () => {
    expect(readFileSync("src/routes/portalLenders.ts", "utf8")).toContain('"/lenders/:id/sba"');
    expect(readFileSync("src/routes/lenderSelf.ts", "utf8")).toContain('"/me/sba"');
    expect(readFileSync("src/signnow/sba/sbaSigning.ts", "utf8")).toContain("AND COALESCE(l.offers_sba, true) = true");
    expect(readFileSync("migrations/2026_10_05_v753_lender_offers_sba.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS offers_sba BOOLEAN");
  });
});
