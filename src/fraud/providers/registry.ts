// BF_SERVER_v846_FRAUD - corporate registry lookups for check 6 (business reality check).
//
// Canada (federal): the Corporations Canada API (ISED API store). It looks corporations up by corporation number or
// 9-digit business number (it has no name search), so the check runs when the file carries one of those. Set
// CORPORATIONS_CANADA_API_KEY (sent as the user-key header). Provincial registries are not covered; a business
// registered only provincially is reported as "not found federally", never as fake.
import { defaultFetch, networkAllowed, requestJson, type FetchLike } from "./http.js";

export type RegistryRecord = {
  found: true;
  name: string | null;
  status: string | null;
  active: boolean | null;
  directors: string[];
  address: string | null;
  corporationId: string;
};

export type RegistryLookup =
  | RegistryRecord
  | { found: false; reason: "not_found" | "no_number" }
  | { error: string };

export interface RegistryProvider {
  readonly name: string;
  configured(): boolean;
  lookup(number: string): Promise<RegistryLookup>;
}

export const CORPORATIONS_CANADA_BASE = "https://apigateway-passerelledapi.ised-isde.canada.ca/corporations/api";

/** 9-digit BN (first 9 digits of a 15-character BN like 123456789RC0001) or a 7-digit corporation number. */
export function registryNumber(raw: string | null | undefined): { kind: "bn9" | "corp"; value: string } | null {
  const s = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  const bn = s.match(/^(\d{9})(?:[A-Z]{2}\d{4})?$/);
  if (bn) return { kind: "bn9", value: bn[1]! };
  const corp = s.match(/^(\d{6,7})$/);
  if (corp) return { kind: "corp", value: corp[1]!.padStart(7, "0") };
  return null;
}

/** The v1 corporation body -> the fields the check needs. Exported for tests. */
export function parseCorporation(body: any): Omit<RegistryRecord, "directors" | "found"> | null {
  const c = Array.isArray(body) ? body[0] : body;
  if (!c || typeof c !== "object") return null;
  const names: any[] = Array.isArray(c.corporationNames) ? c.corporationNames : [];
  const nameObj = names.map((n) => n?.CorporationName ?? n).find((n) => n && (n.current === true || n.current === "true")) ?? names[0]?.CorporationName ?? names[0];
  const statusRaw = c.status;
  const status = typeof statusRaw === "string" ? statusRaw : typeof statusRaw?.text === "string" ? statusRaw.text : Array.isArray(statusRaw) ? String(statusRaw[0]?.text ?? statusRaw[0] ?? "") : null;
  const addrs: any[] = Array.isArray(c.adresses) ? c.adresses : Array.isArray(c.addresses) ? c.addresses : [];
  const a = addrs.map((x) => x?.address ?? x)[0];
  const address = a ? [a.addressLine, a.city, a.provinceCode, a.postalCode].flat().filter(Boolean).join(", ") : null;
  return {
    name: typeof nameObj?.name === "string" ? nameObj.name : null,
    status: status || null,
    active: status ? /^active/i.test(status) : null,
    address,
    corporationId: String(c.corporationId ?? ""),
  };
}

export function parseDirectors(body: any): string[] {
  const list: any[] = body?._embedded?.directors ?? body?.directors ?? [];
  return list.map((d) => [d?.firstName, d?.middleName, d?.lastName].filter(Boolean).join(" ").trim()).filter(Boolean);
}

export function corporationsCanadaProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): RegistryProvider {
  const key = String(env.CORPORATIONS_CANADA_API_KEY ?? "").trim();
  const base = String(env.CORPORATIONS_CANADA_BASE_URL ?? CORPORATIONS_CANADA_BASE).replace(/\/+$/, "");
  const f = fetchImpl ?? defaultFetch();
  return {
    name: "corporations_canada",
    configured: () => Boolean(key) && networkAllowed(fetchImpl, env),
    async lookup(raw: string): Promise<RegistryLookup> {
      const n = registryNumber(raw);
      if (!n) return { found: false, reason: "no_number" };
      const headers = { "user-key": key };
      const corp = await requestJson(f, `${base}/v1/corporations/${n.value}.json?lang=eng`, { headers });
      if (!corp.ok) return corp.status === 404 ? { found: false, reason: "not_found" } : { error: corp.error };
      const parsed = parseCorporation(corp.body);
      if (!parsed || !parsed.corporationId) return { found: false, reason: "not_found" };
      const dirs = await requestJson(f, `${base}/v2/corporations/${parsed.corporationId.padStart(7, "0")}/directors`, { headers: { ...headers, "Accept-Language": "en" } });
      return { found: true, ...parsed, directors: dirs.ok ? parseDirectors(dirs.body) : [] };
    },
  };
}
