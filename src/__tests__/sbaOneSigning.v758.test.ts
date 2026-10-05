// BF_SERVER_SBA_ONE_SIGNING_v758
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const envelopesRow: { value: any[] } = { value: [] };
const groupSigned = new Map<string, boolean>();
vi.mock("../db.js", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (/^\s*SELECT metadata FROM applications/.test(sql)) return { rows: [{ metadata: { sba_signnow: envelopesRow.value } }] };
    return { rows: [] };
  }),
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));
vi.mock("../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<any>()),
  isApiKeyConfigured: () => true,
  getDocumentGroupStatus: vi.fn(async (id: string) => ({ signed: groupSigned.get(id) === true })),
  createEmbeddedGroupLink: vi.fn(async (_g: string, _i: string, email: string) => ({ url: "https://signnow.test/link?for=" + email })),
}));

import { buildApplicationPdf } from "../signnow/pdfBuilder.js";
import { sbaOwnerOneSigningSession, sbaCombinedApplicationDocIfAllSigned } from "../signnow/sba/sbaSigning.js";

const inputs: any = {
  applicationId: "a1", product: { lookingFor: "Working Capital", category: "SBA", amountRequested: 500000 }, funding: {},
  business: { legalName: "Voss Events" },
  owners: [{ label: "Owner 1", firstName: "Brandon", lastName: "Voss", email: "b@x.com" }, { label: "Owner 2", firstName: "Pat", lastName: "Partner", email: "p@x.com" }],
  applicantEmail: "b@x.com", applicantName: "Brandon Voss",
};

describe("one signing per owner", () => {
  beforeEach(() => { envelopesRow.value = []; groupSigned.clear(); });
  it("each owner's copy of the application carries only that owner's signature tag", async () => {
    const all = { dateAnchors: [] as any[] };
    await buildApplicationPdf(inputs, all);
    expect(all.dateAnchors.map((a) => a.role)).toEqual(["Owner 1", "Owner 2"]);
    const mine = { dateAnchors: [] as any[] };
    const bytes = await buildApplicationPdf(inputs, mine, { signOnlyAs: "Owner 2" });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(mine.dateAnchors.map((a) => a.role)).toEqual(["Owner 2"]);
  });
  it("owner 1 gets a fresh portal link, 'signed' once done, and 'not started' before staff send", async () => {
    expect(await sbaOwnerOneSigningSession("a1")).toEqual({ status: "not_ready", reason: "sba_signing_not_started" });
    envelopesRow.value = [{ ownerIndex: 1, email: "b@x.com", groupId: "g1", inviteId: "i1", docIds: ["app1", "f1"], applicationDocId: "app1", delivery: "portal" }];
    const r: any = await sbaOwnerOneSigningSession("a1");
    expect(r.status).toBe("ready");
    expect(r.url).toContain("for=b@x.com");
    groupSigned.set("g1", true);
    expect(await sbaOwnerOneSigningSession("a1")).toEqual({ status: "signed" });
  });
  it("the application counts as signed only when every owner's envelope is signed", async () => {
    envelopesRow.value = [
      { ownerIndex: 1, email: "b@x.com", groupId: "g1", inviteId: "i1", docIds: ["app1"], applicationDocId: "app1" },
      { ownerIndex: 2, email: "p@x.com", groupId: "g2", inviteId: "i2", docIds: ["app2"], applicationDocId: "app2" },
    ];
    groupSigned.set("g1", true);
    expect(await sbaCombinedApplicationDocIfAllSigned("a1")).toBeNull();
    groupSigned.set("g2", true);
    expect(await sbaCombinedApplicationDocIfAllSigned("a1")).toBe("app1");
  });
  it("is wired: staff route, client portal sign item, no auto-start, finalize on the webhook", () => {
    expect(readFileSync("src/routes/applicationFormResponses.ts", "utf8")).toContain('"/applications/:id/sba-signing/send"');
    expect(readFileSync("src/routes/applicationFormResponses.ts", "utf8")).toContain("const SBA_AUTO_START_SIGNING = false;");
    expect(readFileSync("src/signnow/embeddedSigningSession.ts", "utf8")).toContain("return await sbaOwnerOneSigningSession(applicationId);");
    expect(readFileSync("src/routes/signnow.ts", "utf8")).toContain("sbaCombinedApplicationDocIfAllSigned(sbaMatch.rows[0].id)");
    const pdf = readFileSync("src/signnow/pdfBuilder.ts", "utf8");
    expect(pdf).toContain("if (opts?.signOnlyAs) {");
  });
});
