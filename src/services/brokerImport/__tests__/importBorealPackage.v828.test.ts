// BF_SERVER_v828_BOREAL_PACKAGE_PREFILL - importing a Boreal application package names the card after the business
// and stores every field from application-fields.json, without asking the AI to read the PDF.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn(), persist: vi.fn(), llm: vi.fn(), text: vi.fn() }));
vi.mock("../../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));
vi.mock("../../../modules/applications/applications.repo.js", async (orig) => ({ ...(await orig() as any), createApplication: h.create }));
vi.mock("../../../routes/documents.js", () => ({ persistAndEnqueue: h.persist }));
vi.mock("../extract.js", async (orig) => ({ ...(await orig() as any), extractPrefillFromText: h.llm, documentText: h.text }));

import { importBrokerZip } from "../importBrokerFile.js";

function makeZip(files: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const body = Buffer.from(f.data); const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const fields = { "Application Name": "Northwind Grocery Ltd", "kyc.fundingAmount": "$250,000", "company.legalName": "Northwind Grocery Ltd",
  "borrower.firstName": "Jane", "borrower.lastName": "Smith", "borrower.phone": "(780) 555-0100" };

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.query.mockImplementation(answerBySql([[/SELECT id FROM applications/, { rows: [] }]]));
  h.create.mockResolvedValue({ id: "app1" });
  h.persist.mockResolvedValue({});
  h.text.mockResolvedValue("BUSINESS FUNDING APPLICATION ...");
});

describe("importing a Boreal application package", () => {
  it("reads application-fields.json instead of the AI, and does not file the JSON as a document", async () => {
    const zip = makeZip([
      { name: "signed-application.pdf", data: "%PDF" },
      { name: "application-fields.json", data: JSON.stringify(fields) },
      { name: "bank_statements/jan.pdf", data: "%PDF" },
    ]);
    const out = await importBrokerZip({ zip, zipName: "northwind.zip", brokerName: "Prairie Bank", uploadedBy: "lender:1", applicantPhone: null });
    expect(h.llm).not.toHaveBeenCalled();
    expect(out.businessName).toBe("Northwind Grocery Ltd");
    expect(out.applicantPhone).toBe("+17805550100");
    expect(out.prefill?.kyc.fundingAmount).toBe(250000);
    const created = h.create.mock.calls[0]![0] as any;
    expect(created.name).toBe("Northwind Grocery Ltd");
    expect(created.requestedAmount).toBe(250000);
    expect(created.metadata.broker_prefill.applicant).toMatchObject({ firstName: "Jane", lastName: "Smith" });
    expect(h.persist.mock.calls.map((c) => (c[0] as any).file.originalname)).toEqual(["Prairie Bank application - signed-application.pdf", "jan.pdf"]);
    expect(callsMatching(h.query, /status='awaiting_client'/)).toHaveLength(1);
  });

  it("still uses the AI on a zip without the package fields", async () => {
    h.llm.mockResolvedValue(null);
    await importBrokerZip({ zip: makeZip([{ name: "application.pdf", data: "%PDF" }]), zipName: "x.zip", brokerName: "Avance", uploadedBy: null, applicantPhone: null });
    expect(h.llm).toHaveBeenCalledTimes(1);
  });
});
