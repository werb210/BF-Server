// BF_SERVER_LENDER_SBA_IVES_v753
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
import lenderSelf from "../routes/lenderSelf.js";
import portalLenders from "../routes/portalLenders.js";
import { loadIvesLenders } from "../signnow/sba/sbaSigning.js";
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
  it("routes exist for staff and for the lender, and a lender saying no gets no 4506-C", async () => {
    const LENDER_ID = "12121212-3434-4565-8787-909090909090";
    const stored = { offers_sba: false, ives_participant_name: null, ives_participant_id: null, ives_sor_mailbox_id: null, ives_street: null, ives_city: null, ives_state: null, ives_zip: null };
    h.query.mockImplementation(answerBySql([
      [/SELECT offers_sba, ives_participant_name/, { rows: [stored] }],
      [/UPDATE lenders SET offers_sba = \$2/, { rows: [{ id: LENDER_ID }] }],
    ]));
    const app = express();
    app.use(express.json());
    app.use("/api/lender", lenderSelf);
    app.use("/api/portal", portalLenders);
    const staff = jwt.sign({ sub: "13131313-1313-4313-8313-131313131313", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const lender = jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);

    const staffGet = await request(app).get(`/api/portal/lenders/${LENDER_ID}/sba`).set("Authorization", `Bearer ${staff}`);
    expect(staffGet.status).toBe(200);
    expect(staffGet.body).toMatchObject({ offersSba: false });

    const mine = await request(app).get("/api/lender/me/sba").set("Authorization", `Bearer ${lender}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ offersSba: false });
    expect(callsMatching(h.query, /SELECT offers_sba/).every((c) => (c[1] as unknown[])[0] === LENDER_ID)).toBe(true);

    const bad = await request(app).put("/api/lender/me/sba").set("Authorization", `Bearer ${lender}`).send({ offersSba: true });
    expect(bad.status).toBe(400);
    const saved = await request(app).put("/api/lender/me/sba").set("Authorization", `Bearer ${lender}`).send({ offersSba: false });
    expect(saved.status).toBe(200);
    expect(callsMatching(h.query, /UPDATE lenders SET offers_sba = \$2/)[0][1]).toEqual(expect.arrayContaining([LENDER_ID, false]));

    // A lender that answered "no" is filtered out of the 4506-C participants; unanswered still counts.
    h.query.mockImplementation(answerBySql([]));
    await loadIvesLenders("app-1");
    const ives = String(callsMatching(h.query, /FROM application_lender_selections s/)[0][0]);
    expect(ives).toContain("AND COALESCE(l.offers_sba, true) = true");

    expect(readFileSync("migrations/2026_10_05_v753_lender_offers_sba.sql", "utf8")).toContain("ADD COLUMN IF NOT EXISTS offers_sba BOOLEAN");
  });
});
