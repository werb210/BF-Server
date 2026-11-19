// BF_SERVER_v960_LENDER_REPS - once a rep is handling the file at a lender, the package goes to that rep by email and
// only to them: not the lender's general address, not its API. The database answers by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../../modules/lenderSubmissions/adapters/EmailAdapter", () => ({ sendLenderEmail: h.send }));
// SECURITY_SWEEP_2026_11_19 - the lender endpoint public-address check does a DNS lookup; the tests use fake hosts.
vi.mock("../../../security/ssrfGuard.js", async (orig) => ({ ...(await orig<any>()), assertPublicUrl: async () => undefined }));
vi.mock("../buildApplicationPackage", () => ({ buildApplicationPackage: vi.fn().mockResolvedValue({ zipBuffer: Buffer.from("zip") }) }));
vi.mock("../loadPackageInputs", () => ({ loadPackageInputs: vi.fn().mockResolvedValue({ signedApplicationPdf: Buffer.from("signed"), creditSummaryPdf: null, documents: [], fields: [{ label: "Application Name", value: "Sample Co" }] }) }));

function poolWith(rep: { name: string; email: string } | null) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/FROM application_lender_reps a JOIN lender_reps r/.test(String(sql))) {
        return { rows: rep ? [{ id: "r1", lender_id: "lender-1", position: null, phone: null, ...rep }] : [], rowCount: rep ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
  } as any;
}
const lender = { lender_id: "lender-1", name: "Sample Lender", submission_method: "api", submission_email: "deals@lender.example", api_endpoint: "https://lender.example/submit", api_key_encrypted: null, google_sheet_id: null };

describe("a package for a file with a lender rep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.send.mockImplementation(async (input: any) => ({ ok: true, provider: "graph", deliveredTo: input.lender.submission_email }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "x" }), { status: 200 })));
  });

  it("goes to the rep by email, greeted by name, and not to the lender's API or general address", async () => {
    const { dispatchToSelected } = await import("../dispatchToSelected.js");
    const sent = await dispatchToSelected({ pool: poolWith({ name: "Pat Sample", email: "pat@lender.example" }), applicationId: "app-1" }, [lender]);
    expect(sent).toEqual(["lender-1"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    const input = h.send.mock.calls[0]![0];
    expect(input.lender.submission_email).toBe("pat@lender.example");
    expect(input.bodyText).toMatch(/^Hello Pat,/);
  });

  it("with no rep, the lender's own method is used as before", async () => {
    const { dispatchToSelected } = await import("../dispatchToSelected.js");
    const sent = await dispatchToSelected({ pool: poolWith(null), applicationId: "app-1" }, [lender]);
    expect(sent).toEqual(["lender-1"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});
