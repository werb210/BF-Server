// BF_SERVER_BLOCK_v458_LENDER_EMAIL
export type LenderEmailDetails = { lenderName: string; applicationId: string; businessName?: string | null; requestedAmount?: number | null; productCategory?: string | null; contents?: string[] };
export type LenderEmailDelivery = { mode: "attached"; sizeBytes: number } | { mode: "link"; sizeBytes: number; url: string; expiresAt: Date };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const formatMegabytes = (sizeBytes: number): string => `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
export function formatAmount(amount: number | null | undefined): string | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}
const formatDate = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const publicBase = () => (process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");

export function lenderEmailSubject(d: LenderEmailDetails): string {
  const who = (d.businessName ?? "").trim() || `application ${d.applicationId.slice(0, 8)}`;
  const amount = formatAmount(d.requestedAmount);
  return `Boreal Financial application package: ${who}${amount ? ` (${amount})` : ""}`;
}

export function lenderEmail(d: LenderEmailDetails, delivery: LenderEmailDelivery): { bodyText: string; bodyHtml: string } {
  const business = (d.businessName ?? "").trim() || "Not provided";
  const amount = formatAmount(d.requestedAmount) ?? "Not provided";
  const product = (d.productCategory ?? "").trim() || "Not provided";
  const size = formatMegabytes(delivery.sizeBytes);
  const contents = (d.contents ?? []).map((c) => c.trim()).filter(Boolean);
  const isLink = delivery.mode === "link";
  const host = isLink ? new URL(delivery.url).host : "";
  const until = isLink ? formatDate(delivery.expiresAt) : "";
  const text = [`Hello ${d.lenderName} team,`, "", "Boreal Financial is submitting the following financing application for your review.", "", `Applicant: ${business}`, `Requested amount: ${amount}`, `Product: ${product}`, `Boreal reference: ${d.applicationId}`, ""];
  if (contents.length) text.push("The package contains:", ...contents.map((c) => `- ${c}`), "");
  if (isLink) text.push(`Download the application package (${size} zip):`, delivery.url, "", "About this link:", `- It goes to ${host}, Boreal Financial's own secure server - the same organization this email comes from. It is not a third-party file-sharing site.`, "- It downloads one standard .zip file of the application documents. There is no login, no software to install and nothing to enable.", `- The link was created for ${d.lenderName} only and stops working on ${until}.`, "- If you would like to confirm this email is genuine before downloading, reply to it or call your Boreal Financial contact.", "");
  else text.push(`The complete package is attached as one .zip file (${size}).`, "");
  text.push("This package contains confidential applicant information. Please keep it within your credit team.");
  const row = (label: string, value: string) => `<tr><td style="padding:4px 16px 4px 0;color:#64748b;white-space:nowrap">${esc(label)}</td><td style="padding:4px 0;color:#0f172a;font-weight:600">${esc(value)}</td></tr>`;
  const html = [`<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:600px">`, `<img src="${esc(publicBase())}/api/public/email/logo.png" alt="Boreal Financial" width="240" style="display:block;border:0;margin:0 0 20px">`, `<p style="margin:0 0 12px">Hello ${esc(d.lenderName)} team,</p>`, `<p style="margin:0 0 16px">Boreal Financial is submitting the following financing application for your review.</p>`, `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px">`, row("Applicant", business), row("Requested amount", amount), row("Product", product), row("Boreal reference", d.applicationId), `</table>`];
  if (contents.length) html.push(`<p style="margin:0 0 6px;font-weight:600">The package contains:</p>`, `<ul style="margin:0 0 16px;padding-left:20px">${contents.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`);
  if (isLink) html.push(`<p style="margin:0 0 20px"><a href="${esc(delivery.url)}" style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">Download application package (${esc(size)} zip)</a></p>`, `<div style="background:#f1f5f9;border-left:4px solid #1e3a8a;padding:12px 16px;margin:0 0 16px;font-size:13px"><p style="margin:0 0 6px;font-weight:600">About this link</p><ul style="margin:0;padding-left:18px"><li>It goes to <strong>${esc(host)}</strong>, Boreal Financial's own secure server &mdash; the same organization this email comes from. It is not a third-party file-sharing site.</li><li>It downloads one standard .zip file of the application documents. There is no login, no software to install and nothing to enable.</li><li>The link was created for ${esc(d.lenderName)} only and stops working on ${esc(until)}.</li><li>If you would like to confirm this email is genuine before downloading, reply to it or call your Boreal Financial contact.</li></ul></div>`);
  else html.push(`<p style="margin:0 0 16px">The complete package is attached as one .zip file (${esc(size)}).</p>`);
  html.push(`<p style="margin:0;color:#64748b;font-size:12px">This package contains confidential applicant information. Please keep it within your credit team.</p>`, `</div>`);
  return { bodyText: text.join("\n"), bodyHtml: html.join("") };
}
