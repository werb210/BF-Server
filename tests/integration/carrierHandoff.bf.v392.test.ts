// BF_SERVER_BLOCK_v392_CARRIER_HANDOFF_TESTS_v1
// Integration coverage for the two BF→outside-world handoffs that have
// to be correct for go-live, following this repo's convention of
// mocking the DB/HTTP/Graph deps rather than standing up Postgres:
//
//   1. PGI handoff (BF loan opts into insurance) — buildBiPayload maps
//      the wizard payload into the BI submission shape, and postBiHandoff
//      round-trips it to BI-Server. Exercised across all four BF product
//      types (capital, equipment, equipment+closing, capital&equipment)
//      since each leg carries its own loan amount → its own pgi_limit.
//
//   2. Staff-accept → send package to lender by email — sendLenderEmail
//      dispatches via Microsoft Graph to the lender's submission_email.
//
// Graph + fetch are faked so nothing real is sent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- No module mock for Graph -------------------------------------------
// graphSendService is a static ESM import inside EmailAdapter; vi.mock by
// path proved flaky against this repo's NodeNext/.js resolution. Instead we
// drive the REAL sendViaGraph through its only external seam — global fetch
// (used for both the OAuth token and the sendMail call) — which is a
// stronger test: it verifies the actual Graph request shape, recipient,
// and attachment. MS_GRAPH_* env is set in the email describe block so
// isConfigured() passes.

import { buildBiPayload, postBiHandoff, type BiHandoffInput } from "@/services/biHandoff";
import { sendLenderEmail } from "@/modules/lenderSubmissions/adapters/EmailAdapter";

// A realistic Step-6 wizard payload. Each product variant overrides the
// economic fields; everything else (applicant/business/kyc) is shared.
function wizardPayload(over: { kyc?: Record<string, unknown>; selected?: Record<string, unknown> } = {}) {
  return {
    applicant: {
      firstName: "Bob", lastName: "Belcher", email: "bob@belcher.test",
      phone: "+15875550100", dob: "1980-01-01",
      street: "125 Main St", city: "Calgary", province: "AB", postal: "T2P 1A1",
    },
    business: {
      businessName: "Bob's Burgers Ltd.", businessStructure: "Corporation",
      businessNumber: "123456789RC0001", startDate: "2019-04-01",
      street: "125 Main St", city: "Calgary", province: "AB", postal: "T2P 1A1",
    },
    kyc: {
      industry: "restaurant", purposeOfFunds: "Working capital",
      annualRevenue: 2_000_000, availableCollateral: 600_000,
      ...over.kyc,
    },
    selected_product: { lender_name: "Acme Capital", ...over.selected },
  };
}

describe("v392 — PGI/BI handoff payload across product types", () => {
  it("CAPITAL: maps applicant/business and derives pgi_limit = 80% of loan", () => {
    const input: BiHandoffInput = {
      bfApplicationId: "bf-app-capital",
      legacyApp: wizardPayload({ kyc: { capitalAmount: 500_000 } }),
    };
    const p = buildBiPayload(input);
    expect(p.bf_application_id).toBe("bf-app-capital");
    expect(p.guarantor_name).toBe("Bob Belcher");
    expect(p.guarantor_email).toBe("bob@belcher.test");
    expect(p.business_name).toBe("Bob's Burgers Ltd.");
    expect(p.naics_code).toBe("722500"); // restaurant → best-effort NAICS
    expect(p.loan_amount).toBe(500_000);
    expect(p.pgi_limit).toBe(400_000); // round(500k * 0.8)
    expect(p.lender_name).toBe("Acme Capital");
  });

  it("EQUIPMENT: per-leg loanAmountOverride drives the policy value", () => {
    const input: BiHandoffInput = {
      bfApplicationId: "bf-app-equipment",
      legacyApp: wizardPayload({ kyc: { capitalAmount: 500_000 } }),
      loanAmountOverride: 250_000, // equipment leg only
    };
    const p = buildBiPayload(input);
    expect(p.loan_amount).toBe(250_000);
    expect(p.pgi_limit).toBe(200_000); // round(250k * 0.8)
  });

  it("EQUIPMENT + CLOSING COSTS: override carries the combined leg amount", () => {
    const input: BiHandoffInput = {
      bfApplicationId: "bf-app-equip-closing",
      legacyApp: wizardPayload(),
      loanAmountOverride: 312_500,
    };
    const p = buildBiPayload(input);
    expect(p.loan_amount).toBe(312_500);
    expect(p.pgi_limit).toBe(250_000); // round(312500 * 0.8)
  });

  it("CAPITAL & EQUIPMENT: derives from kyc.fundingAmount when no override", () => {
    const input: BiHandoffInput = {
      bfApplicationId: "bf-app-cap-equip",
      legacyApp: wizardPayload({ kyc: { fundingAmount: 750_000 } }),
    };
    const p = buildBiPayload(input);
    expect(p.loan_amount).toBe(750_000);
    expect(p.pgi_limit).toBe(600_000);
  });

  it("null loan amount → null pgi_limit (no fake $0 policy)", () => {
    const p = buildBiPayload({ bfApplicationId: "bf-x", legacyApp: { applicant: {}, business: {}, kyc: {} } });
    expect(p.loan_amount).toBeNull();
    expect(p.pgi_limit).toBeNull();
  });

  it("unknown industry → naics null + confidence false (BI flags as required)", () => {
    const p = buildBiPayload({ bfApplicationId: "bf-y", legacyApp: wizardPayload({ kyc: { industry: "underwater basket weaving", capitalAmount: 100_000 } }) });
    expect(p.naics_code).toBeNull();
    expect(p.naics_confidence).toBe(false);
  });
});

describe("v392 — postBiHandoff round-trip (fetch mocked)", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it("returns the BI completion URL + ids on a successful handoff", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, public_id: "ABC123", application_code: "BI-ABC123", completion_url: "https://www.boreal.insure/applications/ABC123" }),
      text: async () => "",
    })) as any;
    const res = await postBiHandoff({ bfApplicationId: "bf-1", legacyApp: wizardPayload({ kyc: { capitalAmount: 400_000 } }) });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.biPublicId).toBe("ABC123");
      expect(res.biApplicationId).toBe("BI-ABC123");
      expect(res.completionUrl).toContain("/applications/ABC123");
    }
    // It POSTed to the BI from-bf endpoint with a bearer service token.
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(String(url)).toContain("/api/v1/bi/applications/from-bf");
    expect((init.headers as any).authorization).toMatch(/^Bearer /);
  });

  it("a 4xx/5xx from BI surfaces as a typed error (not a throw)", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}), text: async () => "bad" })) as any;
    const res = await postBiHandoff({ bfApplicationId: "bf-2", legacyApp: wizardPayload({ kyc: { capitalAmount: 400_000 } }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bi_422");
  });

  it("a 200 with ok:false body is treated as a bad response", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false }), text: async () => "" })) as any;
    const res = await postBiHandoff({ bfApplicationId: "bf-3", legacyApp: wizardPayload({ kyc: { capitalAmount: 400_000 } }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("bi_bad_response");
  });
});

describe("v392 — staff-accept → send package to lender by email", () => {
  const realFetch = global.fetch;
  // Capture the sendMail request body so we can assert recipient + attachment.
  let lastSendMailBody: any = null;

  beforeEach(() => {
    lastSendMailBody = null;
    process.env.MS_GRAPH_TENANT_ID = "tenant-test";
    process.env.MS_GRAPH_CLIENT_ID = "client-test";
    process.env.MS_GRAPH_CLIENT_SECRET = "secret-test";
    process.env.MS_GRAPH_SEND_AS = "submissions@boreal.test";
    // Route by URL: OAuth token endpoint → token; Graph sendMail → 202.
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-123", expires_in: 3600 }), text: async () => "" } as any;
      }
      if (u.includes("/sendMail")) {
        lastSendMailBody = JSON.parse(String(init?.body ?? "{}"));
        return { status: 202, text: async () => "", json: async () => ({}) } as any;
      }
      return { ok: false, status: 404, text: async () => "unexpected", json: async () => ({}) } as any;
    }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it("emails the package to the lender's submission_email with the attachment", async () => {
    const res = await sendLenderEmail({
      lender: { id: "lender-1", name: "Acme Capital", submission_email: "submissions@acme.test" },
      subject: "Application package — Acme Capital",
      bodyText: "Package attached.",
      attachments: [{ filename: "application-bf-1.zip", contentType: "application/zip", content: Buffer.from("ZIP") }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deliveredTo).toBe("submissions@acme.test");
    // The real Graph sendMail request named the lender as the recipient
    // and carried the package attachment.
    expect(lastSendMailBody).toBeTruthy();
    const recips = lastSendMailBody.message.toRecipients.map((r: any) => r.emailAddress.address);
    expect(recips).toContain("submissions@acme.test");
    expect(lastSendMailBody.message.attachments).toHaveLength(1);
    expect(lastSendMailBody.message.attachments[0].name).toBe("application-bf-1.zip");
  });

  it("does NOT send (reports an error) when the lender has no submission_email", async () => {
    const res = await sendLenderEmail({
      lender: { id: "lender-2", name: "No-Email Lender", submission_email: null },
      subject: "x", bodyText: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no submission_email/);
    // No sendMail attempt was made.
    expect(lastSendMailBody).toBeNull();
  });

  it("surfaces a Graph send failure (non-202) as a non-ok result", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }), text: async () => "" } as any;
      return { status: 500, text: async () => "graph boom", json: async () => ({}) } as any;
    }) as any;
    const res = await sendLenderEmail({
      lender: { id: "lender-3", name: "Acme", submission_email: "s@acme.test" },
      subject: "x", bodyText: "y",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/graph_send_failed|500/);
  });
});
