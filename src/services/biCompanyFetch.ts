// BF_SERVER_BLOCK_v819_IMPORT_FROM_BI_VIA_API
// BF cannot read bi_companies (separate database). Fetch the company +
// primary-contact shape from BI-Server over HTTP, using the same service
// JWT pattern as biHandoff.ts / biDocMirror.ts (no new env var).
import jwt from "jsonwebtoken";

const BI_SERVER_URL =
  process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

export type BIImportCompany = {
  id: string;
  legal_name: string | null;
  website: string | null;
  phone: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  tags: string[];
  primary_contact: { full_name: string | null; email: string | null; phone_e164: string | null } | null;
};

function serviceToken(): string {
  const secret = process.env.JWT_SECRET || "";
  return jwt.sign({ kind: "service", source: "bf-server" }, secret, { expiresIn: "5m" });
}

export async function fetchBiCompaniesByIds(ids: string[]): Promise<BIImportCompany[]> {
  if (ids.length === 0) return [];
  const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/companies/by-ids/from-bf`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken()}` },
    body: JSON.stringify({ companyIds: ids }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`BI companies fetch failed: ${r.status} ${body.slice(0, 300)}`);
  }
  const j = (await r.json()) as { ok?: boolean; data?: BIImportCompany[] };
  return Array.isArray(j?.data) ? j.data : [];
}
