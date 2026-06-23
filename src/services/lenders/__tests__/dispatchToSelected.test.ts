import { beforeEach, describe, expect, it, vi } from "vitest";

const submitMock = vi.fn();
const GoogleSheetSubmissionAdapterMock = vi.fn(function (this: any, _cfg: unknown) { this.submit = submitMock; });

vi.mock("../../../modules/submissions/adapters/GoogleSheetSubmissionAdapter", () => ({
  GoogleSheetSubmissionAdapter: GoogleSheetSubmissionAdapterMock,
}));
vi.mock("../../../modules/lenderSubmissions/adapters/EmailAdapter", () => ({ sendLenderEmail: vi.fn() }));
vi.mock("../buildApplicationPackage", () => ({ buildApplicationPackage: vi.fn().mockResolvedValue({ zipBuffer: Buffer.from("zip") }) }));
vi.mock("../loadPackageInputs", () => ({ loadPackageInputs: vi.fn().mockResolvedValue({ signedApplicationPdf: Buffer.from("signed"), creditSummaryPdf: Buffer.from("credit"), documents: [{ category: "bank", files: [{ filename: "stmt.pdf", content: Buffer.from("doc") }] }], fields: [{ label: "Business Name", value: "Acme LLC" }] }) }));

describe("dispatchToSelected", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    submitMock.mockResolvedValue({ success: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc123" }), { status: 200 })));
  });

  it("POSTs lender API submission envelope", async () => {
    const { dispatchToSelected } = await import("../dispatchToSelected.js");
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as any;
    const sent = await dispatchToSelected({ pool, applicationId: "app-1" }, [{ lender_id: "lender-1", name: "Lender One", submission_method: "api", submission_email: null, api_endpoint: "https://example.com/submit", api_key_encrypted: "token123", google_sheet_id: null }]);
    expect(sent).toEqual(["lender-1"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://example.com/submit");
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body);
    expect(parsed.applicationId).toBe("app-1");
    expect(parsed.lenderId).toBe("lender-1");
    expect(Array.isArray(parsed.attachments)).toBe(true);
  });

  it("instantiates GoogleSheetSubmissionAdapter for google_sheet method", async () => {
    const { dispatchToSelected } = await import("../dispatchToSelected.js");
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as any;
    const sent = await dispatchToSelected(
      { pool, applicationId: "app-2" },
      [{ lender_id: "lender-2", name: "Sheet Lender", submission_method: "google_sheet", submission_email: null, api_endpoint: null, api_key_encrypted: null, google_sheet_id: "sheet-123" }],
      { loadGoogleAdapter: async () => GoogleSheetSubmissionAdapterMock }
    );
    expect(sent).toEqual(["lender-2"]);
    expect(GoogleSheetSubmissionAdapterMock).toHaveBeenCalledTimes(1);
    expect(GoogleSheetSubmissionAdapterMock).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ spreadsheetId: "sheet-123" }) }));
  });
});
