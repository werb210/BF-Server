// BF_SERVER_v872_KYC - Entrust IDV (formerly Onfido), the default ID-verification vendor.
//
// Why this one: it covers Canadian and US government ID (driver's licences, provincial photo cards, passports, PR
// cards) with a selfie liveness check, its Studio workflows add identity-record (data source) and address checks
// without code here, and it is the only one of the vendors compared with a Canadian API region (api.ca.onfido.com):
// with ONFIDO_REGION=ca (the default) applicant data is stored at rest in Canada.
//
// Flow: create an applicant, start a workflow run with a hosted link, send the applicant to link.url; the vendor
// calls our webhook (X-SHA2-Signature = HMAC-SHA256 of the raw body with the webhook token); we then fetch the run,
// its reports, the ID images and the selfie with our API token. The webhook body is never trusted for the result.
//
// Settings (never logged): ONFIDO_API_TOKEN, ONFIDO_WORKFLOW_ID, ONFIDO_WEBHOOK_TOKEN, ONFIDO_REGION (ca | us | eu).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { KycChecks, KycMedia, KycPerson, KycPii, KycProvider, KycReason, KycResult, KycStatus, SessionResult, WebhookEvent } from "../types.js";

export type BinaryFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any>; arrayBuffer: () => Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;

export const ONFIDO_API_VERSION = "v3.6";
const REGIONS = new Set(["ca", "us", "eu"]);
const TIMEOUT_MS = 15_000;

export function onfidoRegion(env: NodeJS.ProcessEnv = process.env): "ca" | "us" | "eu" {
  const r = String(env.ONFIDO_REGION ?? "").trim().toLowerCase();
  return (REGIONS.has(r) ? r : "ca") as "ca" | "us" | "eu";
}

export function onfidoBase(env: NodeJS.ProcessEnv = process.env): string {
  return `https://api.${onfidoRegion(env)}.onfido.com/${ONFIDO_API_VERSION}`;
}

/** The workflow run status as a Boreal status. awaiting_input = the applicant has not finished. */
export function mapRunStatus(s: unknown): KycStatus {
  switch (String(s ?? "").toLowerCase()) {
    case "approved": return "approved";
    case "declined": return "declined";
    case "review": return "review";
    case "processing": return "processing";
    case "awaiting_input": return "in_progress";
    case "abandoned": return "expired";
    case "error": return "error";
    default: return "in_progress";
  }
}

const REPORT_CHECK: Record<string, string> = {
  document: "document",
  facial_similarity_photo: "face",
  facial_similarity_photo_fully_auto: "face",
  facial_similarity_video: "liveness",
  facial_similarity_motion: "liveness",
  identity_enhanced: "identity_record",
  known_faces: "known_faces",
  proof_of_address: "address",
  watchlist_standard: "watchlist",
  watchlist_enhanced: "watchlist",
  watchlist_aml: "watchlist",
};

const CHECK_LABEL: Record<string, string> = {
  document: "The ID document",
  face: "The selfie match to the ID photo",
  liveness: "The selfie liveness check",
  identity_record: "The identity record (data source) check",
  known_faces: "The repeat-face check",
  address: "The proof of address",
  watchlist: "The watchlist screening",
};

/** Plain-English reasons, built only from report names and results (never from personal data). */
export function reasonsFor(status: KycStatus, checks: KycChecks, vendorReasons: unknown): KycReason[] {
  const out: KycReason[] = [];
  for (const [k, v] of Object.entries(checks)) {
    const label = CHECK_LABEL[k] ?? `The ${k.replace(/_/g, " ")} check`;
    if (v === "clear") out.push({ code: `${k}_clear`, severity: "info", text: `${label} passed.` });
    else if (v === "consider" || v === "caution" || v === "suspected" || v === "rejected") {
      out.push({ code: `${k}_${v}`, severity: v === "rejected" || v === "suspected" ? "red" : "amber", text: `${label} needs a look (result: ${v}).` });
    }
  }
  if (Array.isArray(vendorReasons)) {
    for (const r of vendorReasons.slice(0, 10)) {
      const code = typeof r === "string" ? r : String((r as any)?.code ?? (r as any)?.reason ?? "");
      if (!code) continue;
      const clean = code.replace(/[^a-z0-9_ .-]/gi, "").slice(0, 80);
      out.push({ code: `vendor_${clean.replace(/[ .-]/g, "_").toLowerCase()}`, severity: status === "declined" ? "red" : status === "review" ? "amber" : "info", text: `Vendor reason: ${clean.replace(/_/g, " ")}.` });
    }
  }
  if (status === "approved" && !out.some((r) => r.severity !== "info")) out.unshift({ code: "verified", severity: "info", text: "ID and selfie verified." });
  if (status === "declined" && !out.some((r) => r.severity === "red")) out.unshift({ code: "declined", severity: "red", text: "The vendor declined this verification." });
  if (status === "review" && !out.some((r) => r.severity === "amber")) out.unshift({ code: "review", severity: "amber", text: "The vendor wants a person to review this verification." });
  if (status === "expired") out.push({ code: "abandoned", severity: "info", text: "The applicant did not finish the verification before the link expired." });
  return out;
}

function country3(v: string | null): string | null {
  const c = String(v ?? "").trim().toUpperCase();
  if (c === "CA" || c === "CAN" || c === "CANADA") return "CAN";
  if (c === "US" || c === "USA" || c === "UNITED STATES") return "USA";
  return null;
}

/** The applicant body: name and email always; date of birth and a full address only when we have them. */
export function applicantBody(p: KycPerson): Record<string, unknown> {
  const body: Record<string, unknown> = { first_name: p.firstName || "Applicant", last_name: p.lastName || "Unknown" };
  if (p.email) body.email = p.email;
  if (p.dob && /^\d{4}-\d{2}-\d{2}$/.test(p.dob)) body.dob = p.dob;
  const a = p.address;
  const country = country3(a?.country ?? null);
  if (a && country && a.street && a.city && a.postcode) {
    body.address = {
      country, street: a.street, town: a.city, postcode: a.postcode,
      ...(a.state ? { state: a.state.toUpperCase().slice(0, 2) } : {}),
    };
  }
  return body;
}

export function verifyOnfidoSignature(rawBody: Buffer, header: unknown, token: string): boolean {
  const sig = String(Array.isArray(header) ? header[0] : header ?? "").trim().toLowerCase();
  if (!token || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const want = createHmac("sha256", token).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(sig, "hex"));
}

export function onfidoProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: BinaryFetch): KycProvider {
  const token = String(env.ONFIDO_API_TOKEN ?? "").trim();
  const workflowId = String(env.ONFIDO_WORKFLOW_ID ?? "").trim();
  const webhookToken = String(env.ONFIDO_WEBHOOK_TOKEN ?? "").trim();
  const base = onfidoBase(env);
  const f: BinaryFetch = fetchImpl ?? (globalThis.fetch as unknown as BinaryFetch);
  const networkOk = Boolean(fetchImpl) || env.NODE_ENV !== "test";

  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: true; body: any } | { ok: false; error: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await f(`${base}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Token token=${token}`, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: ctrl.signal,
      });
      let body: any = null;
      try { body = await r.json(); } catch { body = null; }
      // The error text is the vendor's type only (e.g. validation_error); never echo request data.
      if (!r.ok) return { ok: false, error: `onfido_${r.status}${body?.error?.type ? `_${String(body.error.type).slice(0, 40)}` : ""}` };
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: (err as { name?: string })?.name === "AbortError" ? "onfido_timeout" : "onfido_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function download(path: string, fallbackName: string): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 2);
    try {
      const r = await f(`${base}${path}`, { headers: { Authorization: `Token token=${token}` }, signal: ctrl.signal });
      if (!r.ok) return null;
      const buffer = Buffer.from(await r.arrayBuffer());
      const contentType = r.headers?.get("content-type") ?? "image/jpeg";
      return { buffer, contentType, filename: fallbackName };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    key: "onfido",
    label: "Entrust IDV (Onfido)",
    hosted: true,
    settings: ["ONFIDO_API_TOKEN", "ONFIDO_WORKFLOW_ID", "ONFIDO_WEBHOOK_TOKEN", "ONFIDO_REGION (ca, us or eu; default ca)"],
    configured: () => Boolean(token && workflowId && webhookToken) && networkOk,

    async createSession({ person, redirectUrl }): Promise<SessionResult> {
      const a = await call("/applicants", { body: applicantBody(person) });
      if (!a.ok) return a;
      const applicantId = String(a.body?.id ?? "");
      if (!applicantId) return { ok: false, error: "onfido_no_applicant_id" };
      const run = await call("/workflow_runs", {
        body: {
          workflow_id: workflowId,
          applicant_id: applicantId,
          link: { completed_redirect_url: redirectUrl, expired_redirect_url: redirectUrl, language: "en_US" },
        },
      });
      if (!run.ok) return run;
      const runId = String(run.body?.id ?? "");
      const url = String(run.body?.link?.url ?? "");
      if (!runId || !/^https:\/\//.test(url)) return { ok: false, error: "onfido_no_link" };
      const exp = run.body?.link?.expires_at ? new Date(run.body.link.expires_at) : null;
      return { ok: true, vendorApplicantId: applicantId, vendorSessionId: runId, url, expiresAt: exp && !Number.isNaN(exp.getTime()) ? exp : null };
    },

    verifyWebhook(rawBody, headers) {
      return verifyOnfidoSignature(rawBody, headers["x-sha2-signature"], webhookToken);
    },

    parseWebhook(body, rawBody): WebhookEvent | null {
      const p = (body as any)?.payload;
      if (!p || typeof p !== "object") return null;
      const action = String(p.action ?? "");
      const type = String(p.resource_type ?? "");
      const obj = p.object ?? {};
      let sessionId: string | null = null;
      if (type === "workflow_run") sessionId = String(obj.id ?? "") || null;
      else if (type === "workflow_task") sessionId = String(obj.workflow_run_id ?? "") || null;
      return { eventKey: createHash("sha256").update(rawBody).digest("hex"), vendorSessionId: sessionId, action };
    },

    async fetchResult(runId, applicantIdIn) {
      const run = await call(`/workflow_runs/${encodeURIComponent(runId)}`);
      if (!run.ok) return run;
      const status = mapRunStatus(run.body?.status);
      const applicantId = String(run.body?.applicant_id ?? applicantIdIn ?? "");
      const checks: KycChecks = {};
      let pii: KycPii | null = null;
      const media: KycMedia[] = [];
      if (applicantId && (status === "approved" || status === "declined" || status === "review")) {
        const list = await call(`/checks?applicant_id=${encodeURIComponent(applicantId)}`);
        const reportIds: string[] = list.ok ? (list.body?.checks ?? []).flatMap((c: any) => (Array.isArray(c?.report_ids) ? c.report_ids : [])).slice(0, 12) : [];
        for (const id of reportIds) {
          const rep = await call(`/reports/${encodeURIComponent(String(id))}`);
          if (!rep.ok) continue;
          const name = String(rep.body?.name ?? "");
          const key = REPORT_CHECK[name] ?? name;
          if (!key) continue;
          checks[key] = String(rep.body?.sub_result && rep.body?.result !== "clear" ? rep.body.sub_result : rep.body?.result ?? "unknown");
          if (name === "document") {
            const pr = rep.body?.properties ?? {};
            const num = Array.isArray(pr.document_numbers) ? pr.document_numbers.find((d: any) => d?.value)?.value ?? null : null;
            pii = {
              first_name: pr.first_name ?? null, last_name: pr.last_name ?? null, date_of_birth: pr.date_of_birth ?? null,
              document_type: pr.document_type ?? null, document_number: num, issuing_country: pr.issuing_country ?? null,
              issuing_state: pr.issuing_state ?? null, date_of_expiry: pr.date_of_expiry ?? null,
              address: typeof pr.address === "string" ? pr.address : null,
            };
          }
        }
        const docs = await call(`/documents?applicant_id=${encodeURIComponent(applicantId)}`);
        for (const d of (docs.ok ? docs.body?.documents ?? [] : []).slice(0, 4)) {
          const id = String(d?.id ?? "");
          if (!id) continue;
          const side = String(d?.side ?? "");
          media.push({
            kind: side === "front" ? "document_front" : side === "back" ? "document_back" : "document",
            vendorId: id,
            download: () => download(`/documents/${encodeURIComponent(id)}/download`, `id-${side || "document"}.${String(d?.file_type ?? "jpg").replace(/[^a-z0-9]/gi, "") || "jpg"}`),
          });
        }
        const photos = await call(`/live_photos?applicant_id=${encodeURIComponent(applicantId)}`);
        for (const ph of (photos.ok ? photos.body?.live_photos ?? [] : []).slice(0, 1)) {
          const id = String(ph?.id ?? "");
          if (!id) continue;
          media.push({ kind: "selfie", vendorId: id, download: () => download(`/live_photos/${encodeURIComponent(id)}/download`, "selfie.jpg") });
        }
      }
      const result: KycResult = { status, reasons: reasonsFor(status, checks, run.body?.reasons), checks, pii, media };
      return { ok: true, result };
    },
  };
}
