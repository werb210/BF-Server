// BF_SERVER_SBA_DOC_KEYS_v111
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const repo = vi.hoisted(() => ({ created: [] as any[] }));
vi.mock("../../repositories/lenderProducts.repo.js", async (orig) => ({
  ...(await orig<any>()),
  createLenderProduct: async (input: any) => { repo.created.push(input); return { id: "p1", name: input.name, required_documents: input.requiredDocuments }; },
}));

import router, { PORTAL_FORM_DOC_LABELS } from "../portalLenderProducts.js";

// Byte-identical to the portal's sbaTypes keys, the client's FORM_RENDERERS
// registrations, and the document_type values in migrations v88 / v99 / v103.
const SBA_KEYS = [
  "sba_form_413",
  "sba_form_1919",
  "owner_photo_id",
  "formation_documents",
  "personal_tax_returns",
  "business_plan",
  "sba_1919_attachments",
  "debt_schedule",
  "lease_or_loi",
];

const app = express();
app.use(express.json());
app.use("/api/portal", router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status ?? 500).json({ error: err?.code, message: err?.message }));
const staff = "Bearer " + jwt.sign({ sub: "33333333-3333-4333-8333-333333333333", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

/** Save a product with these required-document categories; the categories as stored. */
async function save(categories: string[]) {
  repo.created.length = 0;
  const r = await request(app).post("/api/portal/lender-products").set("Authorization", staff)
    .send({ lenderId: "l1", name: "SBA 7(a)", category: "SBA", requiredDocuments: categories.map((category) => ({ category, required: true, stage: 2 })) });
  return { status: r.status, body: r.body, stored: (repo.created[0]?.requiredDocuments ?? []).map((d: any) => d.category) as string[] };
}

beforeEach(() => { repo.created.length = 0; });

describe("SBA document keys", () => {
  it("every key the portal sends is accepted", async () => {
    const r = await save(SBA_KEYS);
    expect(r.status).toBe(201);
    expect(r.stored).toEqual(SBA_KEYS);
  });

  it("they sit inside the canonical set, not merely in a comment", () => {
    for (const k of SBA_KEYS) expect(PORTAL_FORM_DOC_LABELS.has(k)).toBe(true);
  });

  it("an unknown key is still refused", async () => {
    const r = await save(["sba_form_9999"]);
    expect(r.status).toBe(400);
    expect(repo.created).toHaveLength(0);
  });

  it("business_plan is distinct from the slugified Business plan / projections", async () => {
    // Both must resolve: the SBA pack uses business_plan, the core pack's
    // "Business plan / projections" aliases to business_plan_projections.
    expect((await save(["business_plan", "Business plan / projections"])).stored).toEqual(["business_plan", "Business plan / projections"]);
    expect((await save(["business_plan_projections"])).stored).toEqual(["Business plan / projections"]);
  });

  it("debt_schedule is distinct from the core pack's Debt stack", async () => {
    expect((await save(["debt_schedule", "Debt stack"])).stored).toEqual(["debt_schedule", "Debt stack"]);
    expect((await save(["debt_stack"])).stored).toEqual(["Debt stack"]);
  });

  it("the alias derivation still round-trips a key to itself", async () => {
    // _v628NormalizeKey("sba_form_413") === "sba_form_413", so an entry added as
    // a key resolves through the alias map unchanged, and so does a spelling that slugifies to it.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    for (const k of SBA_KEYS) expect(norm(k)).toBe(k);
    expect((await save(["SBA Form 413", " Owner Photo ID "])).stored).toEqual(["sba_form_413", "owner_photo_id"]);
  });
});
