// BF_SERVER_v873_LENDER_API - the only way a lender connector reaches the internet.
//
// Lender API addresses are typed in by a brokerage Admin, so every call goes through the same SSRF protection as
// outgoing webhooks: HTTPS only, no credentials in the URL, and the socket's DNS lookup refuses private, loopback,
// link-local and cloud-metadata addresses at connect time (so a host that later re-points inward is still refused).
// Redirects are never followed. Responses are capped at 2 MB. Tests swap the client with setLenderHttpForTests.
import https from "node:https";
import { BlockedAddressError, checkUrlShape, safeLookup, systemResolver, type Resolver } from "./ssrf.js";

export type HttpRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
};
export type HttpResponse = { status: number; headers: Record<string, string>; text: string };
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function safeHttpClient(resolve: Resolver = systemResolver): HttpClient {
  return (req) => new Promise<HttpResponse>((resolveP, reject) => {
    const shape = checkUrlShape(req.url);
    if (!shape.ok) { reject(new BlockedAddressError(req.url, shape.error)); return; }
    const body = req.body === undefined ? undefined : (typeof req.body === "string" ? Buffer.from(req.body, "utf8") : req.body);
    const headers: Record<string, string> = { "User-Agent": "BorealFinancial-LenderConnector/1.0", ...(req.headers ?? {}) };
    if (body) headers["Content-Length"] = String(body.length);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const r = https.request(shape.url, { method: req.method, headers, lookup: safeLookup(resolve) as any, agent: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      res.on("end", () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        resolveP({ status: res.statusCode ?? 0, headers: out, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(Object.assign(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`), { code: "ETIMEDOUT" })));
    r.on("error", reject);
    r.end(body);
  });
}

let override: HttpClient | null = null;
/** Tests replace the network. */
export function setLenderHttpForTests(client: HttpClient | null): void {
  override = client;
}
export function lenderHttp(): HttpClient {
  return override ?? safeHttpClient();
}

/** A multipart/form-data body. Parts with `filename` are files. */
export function multipartBody(parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>): { body: Buffer; contentType: string } {
  const boundary = `----BorealBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const safeName = p.name.replace(/["\r\n]/g, "_");
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${p.contentType ?? "application/octet-stream"}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`, "utf8"), typeof p.value === "string" ? Buffer.from(p.value, "utf8") : p.value, Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A 5xx, 429, timeout or network failure is worth retrying; a 4xx (bad key, bad data) is not. */
export function retryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** A short, safe excerpt of a response for the submission log (never more than 300 characters). */
export function excerpt(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}
