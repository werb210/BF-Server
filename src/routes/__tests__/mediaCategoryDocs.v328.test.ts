// BF_SERVER_MEDIA_CATEGORY_DOCS_v328
import { beforeEach, describe, it, expect, vi } from "vitest";
import { computeOutstandingDocs, getRequestItemsForApp, isMediaProductCategory } from "../clientDocumentsNeeded.js";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { docsNeededRules, wizardRequirements, type DocsNeededFixture } from "../../__tests__/helpers/docsNeededHarness.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const APP = "22222222-3333-4444-8555-666666666666";
const MEDIA = ["Budget", "Finance plan", "Tax credit status", "Production schedule", "Minimum guarantees / presales"];

async function requiredFor(f: DocsNeededFixture) {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(docsNeededRules(f)));
  return (await computeOutstandingDocs(APP)).required;
}

describe("a media deal knows its own required documents before a lender is picked", () => {
  it("merges the media set from the application's product category, not only from a finalized product", async () => {
    const required = await requiredFor({ category: "Media Funding", productDocs: null });
    expect(required.map((d) => d.document_type)).toEqual(MEDIA);
    expect(required.every((d) => d.required === true)).toBe(true);
    // A non-media deal gets none of them.
    expect(await requiredFor({ category: "TERM_LOAN" })).toEqual([]);
  });

  it("carries all five media documents, labelled as written", async () => {
    const required = await requiredFor({ category: "MEDIA" });
    for (const label of MEDIA) expect(required).toContainEqual({ document_type: label, label, required: true });
  });

  it("uses the labels the Create Product modal writes, so a finalized media product dedupes instead of doubling", async () => {
    const required = await requiredFor({ category: "MEDIA", productDocs: ["Budget", "Tax credit status", "Production schedule"] });
    const types = required.map((d) => d.document_type);
    expect(types.filter((t) => t === "Budget")).toHaveLength(1);
    expect(types.filter((t) => t === "Tax credit status")).toHaveLength(1);
    expect(types.some((t) => t.startsWith("Tax credit status ("))).toBe(false);
    expect(types.some((t) => t.startsWith("Minimum guarantees / presales ("))).toBe(false);
    expect(new Set(types).size).toBe(types.length);
  });

  it("merges unconditionally, like the product always-required docs, not as a fallback", async () => {
    const required = await requiredFor({ category: "media_funding", metadata: wizardRequirements([{ document_type: "Articles of incorporation", required: true }]) });
    const types = required.map((d) => d.document_type);
    expect(types).toContain("Articles of incorporation");
    for (const label of MEDIA) expect(types).toContain(label);
  });
});

describe("every spelling of the media category is recognised", () => {
  it.each(["MEDIA", "Media", "media_funding", "Media Funding", "MEDIA_FILM_FINANCE", "media-financing"])(
    "%s is media",
    (value) => {
      expect(isMediaProductCategory(value)).toBe(true);
    },
  );

  it.each(["TERM_LOAN", "EQUIPMENT_FINANCE", "", null, undefined, "MEDIATION"])("%s is not media", (value) => {
    expect(isMediaProductCategory(value as unknown)).toBe(false);
  });
});

describe("staff can see what is already in", () => {
  beforeEach(() => queryMock.mockReset());

  it("request-items reports the document types with a live upload", async () => {
    // BF_SERVER_DOC_SHARING_v635 - still built from the live uploads, now also matching same-kind names.
    queryMock.mockImplementation(answerBySql(docsNeededRules({ category: "MEDIA", uploaded: [{ category: "Budget", status: "accepted" }] })));
    const items = await getRequestItemsForApp(APP);
    expect(Object.keys(items).sort()).toEqual(["forms", "formsWaived", "required", "satisfied", "shared", "waived"]);
    expect(items.satisfied).toContain("Budget");
    expect(items.satisfied).not.toContain("Finance plan");
    expect(items.required.map((d) => d.document_type)).toEqual(MEDIA);
  });

  it("a rejected upload does not count as satisfied", async () => {
    queryMock.mockImplementation(answerBySql(docsNeededRules({ category: "MEDIA", uploaded: [{ category: "Budget", status: "rejected" }] })));
    const out = await computeOutstandingDocs(APP);
    expect(out.stillNeeded.map((d) => d.document_type)).toContain("Budget");
    expect(out.rejected).toEqual([{ document_type: "Budget", label: "Budget" }]);
    await getRequestItemsForApp(APP);
    const satisfiedSql = String(callsMatching(queryMock, /SELECT DISTINCT d\.category FROM documents d/)[0]![0]);
    expect(satisfiedSql).toContain("d.status <> 'rejected'");
  });
});
