// BF_EMAIL_TWO_COLUMN_v1 - fixed Boreal-branded marketing email frame with an optional second column.
export type BrandedEmailFields = {
  headline: string; heroUrl: string; heroLink: string; body: string;
  ctaLabel: string; ctaUrl: string; image2Url: string; image2Link: string;
  headline2?: string; body2?: string;
  secondHeadline?: string; secondBody?: string;
  rightHeadline?: string; rightBody?: string; rightImageUrl?: string; rightImageLink?: string;
  // BF_EMAIL_SECOND_COLUMN_CTA_v1
  cta2Label?: string; cta2Url?: string;
};

const BRAND = "#1E3A8A";
const ADDRESS = "450 Sparling Crt SW, Edmonton, AB T6X 1G9";

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function attr(s: string): string {
  return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function bodyHtml(s: string): string {
  const escaped = esc(s);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${attr(u)}" style="color:${BRAND};">${u}</a>`);
  return linked.replace(/\r?\n/g, "<br>");
}
function img(url: string, link: string): string {
  if (!url) return "";
  const tag = `<img src="${attr(url)}" alt="" width="544" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:6px;">`;
  const inner = link ? `<a href="${attr(link)}" target="_blank">${tag}</a>` : tag;
  return `<tr><td style="padding:20px 28px 0;">${inner}</td></tr>`;
}

// BF_EMAIL_SECOND_COLUMN_CTA_v1 - a button sized for a 264px column rather than
// the 544px frame, so it does not overflow on a phone once the columns stack.
function columnCta(label: string, url: string): string {
  if (!label || !url) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr><td style="border-radius:6px;background:${BRAND};"><a href="${attr(url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}

function column(headline: string, body: string, imageUrl: string, imageLink: string, ctaLabel = "", ctaUrl = ""): string {
  const heading = headline ? `<h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;color:${BRAND};">${esc(headline)}</h1>` : "";
  const imageTag = imageUrl ? `<img src="${attr(imageUrl)}" alt="" width="264" style="display:block;width:100%;max-width:264px;height:auto;border:0;border-radius:6px;">` : "";
  const image = imageTag && imageLink ? `<a href="${attr(imageLink)}" target="_blank">${imageTag}</a>` : imageTag;
  const copy = body ? `<div style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#333333;">${bodyHtml(body)}</div>` : "";
  return `${heading}${image}${copy}${columnCta(ctaLabel, ctaUrl)}`;
}

export function renderBrandedEmail(f: BrandedEmailFields): string {
  const logo = (process.env.PUBLIC_SERVER_URL || "https://server.boreal.financial") + "/api/public/email/logo.png";
  const headline = f.headline ? `<tr><td style="padding:28px 28px 0;"><h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;color:${BRAND};">${esc(f.headline)}</h1></td></tr>` : "";
  const hero = img(f.heroUrl, f.heroLink);
  const body = f.body ? `<tr><td style="padding:20px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#333333;">${bodyHtml(f.body)}</td></tr>` : "";
  const cta = (f.ctaLabel && f.ctaUrl) ? `<tr><td style="padding:26px 28px 0;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:${BRAND};"><a href="${attr(f.ctaUrl)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(f.ctaLabel)}</a></td></tr></table></td></tr>` : "";
  const image2 = img(f.image2Url, f.image2Link);
  const secondHeadline = f.headline2 ?? f.secondHeadline ?? f.rightHeadline ?? "";
  const secondBody = f.body2 ?? f.secondBody ?? f.rightBody ?? "";
  // BF_EMAIL_SECOND_IMAGE_v1 - the composer sends two independent image controls:
  // the right-column picture and the standalone picture below the frame. They are
  // always present as empty strings, so a nullish fallback between them resolved
  // to the empty string and the right column silently lost its picture. Each
  // control now feeds exactly one slot and neither borrows from the other.
  const secondImageUrl = f.rightImageUrl || "";
  const secondImageLink = f.rightImageLink || "";
  const hasSecondColumn = Boolean(secondHeadline || secondBody || f.rightImageUrl);
  const columns = hasSecondColumn ? `<tr><td style="padding:28px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="email-column" width="264" valign="top" style="width:264px;">${column(f.headline, f.body, f.heroUrl, f.heroLink, f.ctaLabel, f.ctaUrl)}</td>
<td class="email-gutter" width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
<td class="email-column" width="264" valign="top" style="width:264px;">${column(secondHeadline, secondBody, secondImageUrl, secondImageLink, f.cta2Label ?? "", f.cta2Url ?? "")}</td>
</tr></table></td></tr>` : "";
  const responsiveStyle = hasSecondColumn ? `<style>@media only screen and (max-width:620px){.email-column{display:block!important;width:100%!important;max-width:544px!important;}.email-gutter{display:block!important;width:100%!important;height:20px!important;}}</style>` : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${responsiveStyle}</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:${BRAND};padding:22px;text-align:center;"><img src="${logo}" alt="Boreal Financial" width="300" style="display:inline-block;width:300px;max-width:80%;height:auto;border:0;"></td></tr>
${hasSecondColumn ? columns : `${headline}${hero}${body}${cta}`}${image2}
<tr><td style="padding:30px 28px 28px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;"><p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;"><strong>Boreal Financial</strong><br>${ADDRESS}</p><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#9ca3af;">You received this email because you connected with Boreal Financial.</p></td></tr>
</table></td></tr></table></body></html>`;
}
