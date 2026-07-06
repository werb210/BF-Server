// BF_SERVER_PNW_ATTACH_v1 - the signed Personal Net Worth PDF must be attached
// to the application's Documents list, not only surfaced inside the lender
// package. Attachment fires from the SignNow webhook on PNW completion and, as
// a backfill, when staff open the application.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pnw = readFileSync(join(process.cwd(), "src", "signnow", "pnwSigning.ts"), "utf-8");
const webhook = readFileSync(join(process.cwd(), "src", "routes", "signnow.ts"), "utf-8");
const portal = readFileSync(join(process.cwd(), "src", "routes", "portal.ts"), "utf-8");

describe("PNW document attachment helper", () => {
  it("exports attachSignedPnwDocument and a Documents-list category", () => {
    expect(pnw).toContain("export async function attachSignedPnwDocument");
    expect(pnw).toContain('PNW_DOCUMENT_CATEGORY = "Personal Net Worth"');
  });

  it("downloads the signed PDF and inserts a documents + document_versions row", () => {
    expect(pnw).toContain("downloadDocument(docId)");
    expect(pnw).toContain("INSERT INTO documents");
    expect(pnw).toContain("INSERT INTO document_versions");
    expect(pnw).toContain("getStorage().put");
  });

  it("is idempotent by content hash", () => {
    expect(pnw).toContain("createHash");
    expect(pnw).toContain("AND hash = $2");
    expect(pnw).toContain("already_attached");
  });

  it("only attaches a confirmed-signed PNW", () => {
    expect(pnw).toContain('if (!status.signed) return { attached: false, reason: "not_signed" }');
  });
});

describe("PNW attachment triggers", () => {
  it("the SignNow webhook attaches on PNW completion (matched by group/doc id)", () => {
    expect(webhook).toContain("BF_SERVER_PNW_ATTACH_v1");
    expect(webhook).toContain("metadata->'pnw_signnow'->>'group_id'");
    expect(webhook).toContain("attachSignedPnwDocument");
    expect(webhook).toContain('match: "pnw"');
  });

  it("staff opening the application backfills an already-signed PNW", () => {
    expect(portal).toContain("BF_SERVER_PNW_ATTACH_v1");
    expect(portal).toContain("attachSignedPnwDocument(record.id)");
  });
});
