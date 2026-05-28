// BF_SERVER_BLOCK_v394_DOC_PACKAGING_E2E_v1
// Proves a real uploaded document survives the full lender-package path
// BYTE-FOR-BYTE, closing the gap that earlier tests left open (they only
// showed *a* file reaching the email plumbing, not that the applicant's
// actual stored bytes do). The chain exercised here:
//
//   stored bytes (real LocalBackend storage)
//     → loadPackageInputs  (real DB read path; pool injected/mocked)
//       → buildApplicationPackage (real archiver zip)
//         → sendLenderEmail (real Graph code path; only global fetch stubbed)
//
// Assertions are byte-identity at each hand-off, including decompressing
// the document entry back out of the real zip (via a tiny built-in-zlib
// central-directory reader, since no zip lib is installed).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import type { Pool } from "pg";
import { loadPackageInputs } from "@/services/lenders/loadPackageInputs";
import { buildApplicationPackage } from "@/services/lenders/buildApplicationPackage";
import { getStorage, __resetStorageForTests } from "@/lib/storage/index";
import { sendLenderEmail } from "@/modules/lenderSubmissions/adapters/EmailAdapter";

// A recognizable "real document" — a tiny but valid PDF with a unique marker
// so byte-identity is unambiguous.
const REAL_DOC = Buffer.from(
  "%PDF-1.4\n% BF-V394-UNIQUE-MARKER-7f3a\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
  "latin1",
);

// --- Minimal ZIP reader: locate an entry via the central directory and
// inflate it with built-in zlib. Enough for archiver's deflate/stored output.
function readZipEntry(zip: Buffer, name: string): Buffer | null {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  // Find End Of Central Directory (scan backwards).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no EOCD — not a valid zip");
  let cdOffset = zip.readUInt32LE(eocd + 16);
  const cdCount = zip.readUInt16LE(eocd + 10);
  for (let n = 0; n < cdCount; n++) {
    if (zip.readUInt32LE(cdOffset) !== CEN_SIG) break;
    const method = zip.readUInt16LE(cdOffset + 10);
    const compSize = zip.readUInt32LE(cdOffset + 20);
    const nameLen = zip.readUInt16LE(cdOffset + 28);
    const extraLen = zip.readUInt16LE(cdOffset + 30);
    const commentLen = zip.readUInt16LE(cdOffset + 32);
    const localOffset = zip.readUInt32LE(cdOffset + 42);
    const entryName = zip.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLen);
    if (entryName === name) {
      // Local header: 30 bytes fixed + name + extra, then data.
      const lhNameLen = zip.readUInt16LE(localOffset + 26);
      const lhExtraLen = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const comp = zip.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const APP_ID = "11111111-1111-1111-1111-111111111111";

// Route loadPackageInputs' SQL to fixtures. The two `applications` queries
// are distinguished by their selected columns.
function makePool(blobName: string, productCategory: string): Pool {
  const query = vi.fn(async (sql: string) => {
    const s = String(sql);
    if (s.includes("FROM applications") && s.includes("signed_application_blob_name")) {
      return { rows: [{ signnow_document_id: null, signed_application_blob_name: null }] };
    }
    if (s.includes("FROM credit_summaries")) return { rows: [] };
    if (s.includes("FROM documents") && s.includes("status = 'accepted'")) {
      return { rows: [{ category: "Bank Statements", document_type: "bank_statement", filename: "march-statement.pdf", storage_path: blobName }] };
    }
    if (s.includes("FROM applications")) {
      return { rows: [{ metadata: { businessName: "Bob's Burgers Ltd." }, name: "Bob's Burgers Ltd.", requested_amount: 250000, product_category: productCategory, product_type: productCategory }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as Pool;
}

describe("v394 — document survives the full lender-package path byte-for-byte", () => {
  beforeEach(() => {
    __resetStorageForTests();
    delete process.env.AZURE_STORAGE_CONNECTION_STRING; // force the LocalBackend
    process.env.NODE_ENV = "test";
    process.env.MS_GRAPH_TENANT_ID = "tenant-test";
    process.env.MS_GRAPH_CLIENT_ID = "client-test";
    process.env.MS_GRAPH_CLIENT_SECRET = "secret-test";
    process.env.MS_GRAPH_SEND_AS = "submissions@boreal.test";
  });
  afterEach(() => { vi.restoreAllMocks(); __resetStorageForTests(); });

  it("loads the exact stored bytes, zips them intact, and emails them intact", async () => {
    // 1) Put a real document into the REAL storage layer.
    const put = await getStorage().put({ buffer: REAL_DOC, filename: "march-statement.pdf", contentType: "application/pdf" });
    expect(put.blobName).toBeTruthy();

    // 2) loadPackageInputs reads it back through the real DB→storage path.
    const inputs = await loadPackageInputs({ pool: makePool(put.blobName, "equipment"), applicationId: APP_ID });
    const group = inputs.documents.find((d) => d.category === "Bank Statements");
    expect(group).toBeTruthy();
    const loaded = group!.files.find((f) => f.filename === "march-statement.pdf");
    expect(loaded).toBeTruthy();
    // BYTE-IDENTITY: storage → inputs.
    expect(loaded!.content.equals(REAL_DOC)).toBe(true);
    // Product category flowed through into the package fields.
    expect(inputs.fields.find((f) => f.label === "Product Category")?.value).toBe("equipment");

    // 3) buildApplicationPackage produces a real zip listing the document.
    const pkg = await buildApplicationPackage({ applicationId: APP_ID, ...inputs });
    const entryName = "Bank Statements/march-statement.pdf";
    expect(pkg.manifest.entries).toContain(entryName);
    expect(pkg.manifest.bytes).toBeGreaterThan(0);

    // BYTE-IDENTITY: the document decompressed back out of the real zip
    // equals the original stored bytes.
    const fromZip = readZipEntry(pkg.zipBuffer, entryName);
    expect(fromZip).not.toBeNull();
    expect(fromZip!.equals(REAL_DOC)).toBe(true);

    // 4) The package reaches the lender's mailbox intact. Drive the real
    // Graph path; stub only fetch (token + sendMail).
    let sendMailBody: any = null;
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }), text: async () => "" } as any;
      if (u.includes("/sendMail")) { sendMailBody = JSON.parse(String(init?.body ?? "{}")); return { status: 202, text: async () => "", json: async () => ({}) } as any; }
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) } as any;
    }) as any;

    try {
      const res = await sendLenderEmail({
        lender: { id: "lender-1", name: "Acme Capital", submission_email: "submissions@acme.test" },
        subject: `Application package — ${APP_ID}`,
        bodyText: "Package attached.",
        attachments: [{ filename: `package-${APP_ID}.zip`, contentType: "application/zip", content: pkg.zipBuffer }],
      });
      expect(res.ok).toBe(true);
      // BYTE-IDENTITY: the zip Graph received equals the zip we built...
      const att = sendMailBody.message.attachments[0];
      expect(att.name).toBe(`package-${APP_ID}.zip`);
      const attachedZip = Buffer.from(att.contentBytes, "base64");
      expect(attachedZip.equals(pkg.zipBuffer)).toBe(true);
      // ...and the document is still recoverable byte-for-byte from THAT zip.
      const fromEmailedZip = readZipEntry(attachedZip, entryName);
      expect(fromEmailedZip!.equals(REAL_DOC)).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });

  it("an unaccepted document is NOT packaged (only accepted docs go to the lender)", async () => {
    const put = await getStorage().put({ buffer: REAL_DOC, filename: "draft.pdf", contentType: "application/pdf" });
    // Pool returns no accepted-document rows.
    const pool = { query: vi.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes("FROM applications") && s.includes("signed_application_blob_name")) return { rows: [{ signnow_document_id: null, signed_application_blob_name: null }] };
      if (s.includes("FROM credit_summaries")) return { rows: [] };
      if (s.includes("FROM documents")) return { rows: [] }; // nothing accepted
      if (s.includes("FROM applications")) return { rows: [{ metadata: {}, name: "X", requested_amount: 1, product_category: "capital", product_type: "capital" }] };
      return { rows: [] };
    }) } as unknown as Pool;
    void put;
    const inputs = await loadPackageInputs({ pool, applicationId: APP_ID });
    expect(inputs.documents).toHaveLength(0);
    const pkg = await buildApplicationPackage({ applicationId: APP_ID, ...inputs });
    // The package still builds (fields + generated PDFs) but carries no
    // applicant document.
    expect(pkg.manifest.entries.some((e) => e.endsWith("draft.pdf"))).toBe(false);
  });
});
