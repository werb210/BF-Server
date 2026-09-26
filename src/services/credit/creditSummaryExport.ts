// BF_SERVER_BLOCK_v540_CREDIT_SUMMARY_EXPORT
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { pool } from "../../db.js";

type Section = { key: string; title: string; text: string; bullets?: string[]; risks?: { risk: string; mitigant: string }[] };
export type ExportDoc = {
  overview: Record<string, string | null>;
  financials: { periods: { label: string }[]; rows: { item: string; values: (number | null)[] }[] };
  equipment: { items: any[]; total: number | null } | null;
  sections: Section[];
};
export type ExportMeta = { signedBy: string | null; phone: string | null; date: Date };
export type Block =
  | { t: "title"; text: string }
  | { t: "h"; text: string }
  | { t: "p"; text: string; bold?: boolean }
  | { t: "bullets"; items: string[] }
  | { t: "table"; head?: string[]; rows: string[][]; firstColBold?: boolean };

export const OVERVIEW_ROWS: [string, string][] = [
  ["applicant_name", "Applicant Name"], ["address", "Address"], ["principals", "Principal(s)"], ["assets", "Assets"],
  ["transaction", "Transaction"], ["structure", "Structure"], ["asset_value", "Asset Value"], ["facility_request", "Facility Request"],
  ["term", "Term"], ["industry", "Industry"], ["ltv", "LTV"], ["additional_security", "Additional Collateral/Security"], ["website", "Website"],
];
const ROW_LABELS: Record<string, string> = { revenue: "Revenue", gross_margin: "Gross Margin", ebitda: "EBITDA", ebitda_plus_rent: "EBITDA + Rent", net_income: "Income", total_debt_service: "Total Debt Service", dscr: "DSCR", current_assets: "Current Assets", current_liabilities: "Current Liabilities", current_ratio: "Liquidity", accounts_receivable: "Accounts Receivable", inventory: "Inventory", ppe_net: "Fixed Assets", long_term_debt: "LT Debt", equity: "Equity", debt_to_equity: "Debt to Equity" };
const RATIOS = new Set(["dscr", "current_ratio", "debt_to_equity"]);
export const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "" : n < 0 ? `($${Math.round(-n).toLocaleString("en-US")})` : `$${Math.round(n).toLocaleString("en-US")}`;
export const cell = (item: string, value: number | null) => value == null ? "" : RATIOS.has(item) ? `${value.toFixed(2)}x` : money(value);
const section = (doc: ExportDoc, key: string) => doc.sections.find((item) => item.key === key);

export function layout(doc: ExportDoc, meta: ExportMeta): Block[] {
  const blocks: Block[] = [
    { t: "title", text: doc.overview.applicant_name ?? "Credit Summary" }, { t: "p", text: "Request for Financing", bold: true },
    { t: "p", text: meta.date.toLocaleDateString("en-CA", { month: "long", year: "numeric" }) }, { t: "h", text: "Application Overview" },
    { t: "table", rows: OVERVIEW_ROWS.map(([key, label]) => [label, doc.overview[key] ?? ""]), firstColBold: true }, { t: "h", text: "Credit Write Up" },
  ];
  for (const key of ["transaction", "overview", "deal_section"]) {
    const value = section(doc, key); if (!value?.text) continue;
    blocks.push({ t: "h", text: value.title });
    for (const paragraph of value.text.split(/\n\s*\n/)) {
      const match = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(paragraph.trim());
      if (match) { blocks.push({ t: "p", text: match[1]!, bold: true }); if (match[2]!.trim()) blocks.push({ t: "p", text: match[2]!.trim() }); }
      else if (paragraph.trim()) blocks.push({ t: "p", text: paragraph.trim() });
    }
  }
  if (doc.equipment?.items.length) blocks.push({ t: "h", text: "Equipment" }, { t: "table", head: ["Year", "Make", "Model", "Hours", "Price"], rows: [...doc.equipment.items.map((item) => [String(item.year ?? ""), String(item.make ?? ""), String(item.model ?? item.description ?? ""), item.hours == null ? "NA" : String(item.hours), money(item.price)]), ["", "", "", "Total", money(doc.equipment.total)]] });
  if (doc.financials.periods.length) blocks.push({ t: "h", text: "Financial Summary" }, { t: "table", head: ["", ...doc.financials.periods.map(({ label }) => label)], rows: doc.financials.rows.map((row) => [ROW_LABELS[row.item] ?? row.item, ...row.values.map((value) => cell(row.item, value))]), firstColBold: true });
  const commentary = section(doc, "financial_commentary"); if (commentary?.text) blocks.push({ t: "p", text: commentary.text });
  const rationale = section(doc, "rationale"); if (rationale?.bullets?.length) blocks.push({ t: "h", text: "Rationale for approval include:" }, { t: "bullets", items: rationale.bullets });
  const risks = section(doc, "risks"); if (risks?.risks?.length) blocks.push({ t: "h", text: "Risks and mitigants" }, { t: "table", head: ["Risk", "Mitigant"], rows: risks.risks.map(({ risk, mitigant }) => [risk, mitigant]) });
  blocks.push({ t: "p", text: "If you have any questions, please give me a call." }, { t: "p", text: "Thanks," }, { t: "p", text: meta.signedBy ?? "", bold: true }, { t: "p", text: "Boreal Financial" });
  if (meta.phone) blocks.push({ t: "p", text: meta.phone }); return blocks;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
const run = (value: string, bold = false, size?: number) => `<w:r><w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
const paragraph = (inner: string, after = 120) => `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
const tableCell = (value: string, bold: boolean, shade?: string) => `<w:tc><w:tcPr>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>${paragraph(run(value, bold, 20), 0)}</w:tc>`;
export function docxXml(blocks: Block[]): string {
  const body = blocks.map((block) => {
    if (block.t === "title") return paragraph(run(block.text, true, 36), 60);
    if (block.t === "h") return paragraph(run(block.text, true, 24), 80);
    if (block.t === "p") return paragraph(run(block.text, block.bold));
    if (block.t === "bullets") return block.items.map((item) => paragraph(run(`•  ${item}`), 60)).join("");
    const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders>';
    const head = block.head ? `<w:tr>${block.head.map((value) => tableCell(value, true, "DCE6F1")).join("")}</w:tr>` : "";
    const rows = block.rows.map((row) => `<w:tr>${row.map((value, index) => tableCell(value, !!block.firstColBold && index === 0)).join("")}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>${head}${rows}</w:tbl>${paragraph("", 120)}`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`;
}

const CRC = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; } return table; })();
function crc32(buffer: Buffer) { let value = 0xffffffff; for (const byte of buffer) value = CRC[(value ^ byte) & 0xff]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
export function zipStored(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const file of files) { const name = Buffer.from(file.name), body = Buffer.from(file.data), crc = crc32(body); const local = Buffer.alloc(30), central = Buffer.alloc(46); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); locals.push(local, name, body); centrals.push(central, name); offset += 30 + name.length + body.length; }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
export function renderDocx(doc: ExportDoc, meta: ExportMeta): Buffer { return zipStored([{ name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' }, { name: "_rels/.rels", data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' }, { name: "word/document.xml", data: docxXml(layout(doc, meta)) }]); }

const safe = (value: string) => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/•/g, "-").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "");
function wrap(value: string, font: PDFFont, size: number, width: number): string[] { const output: string[] = []; for (const raw of safe(value).split("\n")) { let line = ""; for (const word of raw.split(/\s+/)) { const trial = line ? `${line} ${word}` : word; if (font.widthOfTextAtSize(trial, size) <= width || !line) line = trial; else { output.push(line); line = word; } } output.push(line); } return output; }
export async function renderPdf(doc: ExportDoc, meta: ExportMeta): Promise<Buffer> {
  const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold); const margin = 50, width = 512; let page: PDFPage = pdf.addPage([612, 792]), y = 742;
  const need = (height: number) => { if (y - height < margin) { page = pdf.addPage([612, 792]); y = 742; } };
  const text = (value: string, font: PDFFont, size: number, x = margin, available = width, gap = 3) => { for (const line of wrap(value, font, size, available)) { need(size + gap); page.drawText(line, { x, y: y - size, size, font, color: rgb(.1, .1, .12) }); y -= size + gap; } };
  for (const block of layout(doc, meta)) { if (block.t === "title") { text(block.text, bold, 18); y -= 2; } else if (block.t === "h") { y -= 8; text(block.text, bold, 12); y -= 2; } else if (block.t === "p") { text(block.text, block.bold ? bold : regular, 10); y -= 4; } else if (block.t === "bullets") { for (const item of block.items) text(`- ${item}`, regular, 10, margin + 10, width - 10); y -= 4; } else { const columns = (block.head ?? block.rows[0] ?? []).length || 1, first = columns === 2 ? width * .36 : columns > 2 ? width * .28 : width, rest = columns > 1 ? (width - first) / (columns - 1) : 0, widths = Array.from({ length: columns }, (_, index) => index ? rest : first); const draw = (row: string[], heading: boolean) => { const lines = row.map((value, index) => wrap(value, heading || block.firstColBold && index === 0 ? bold : regular, 9, widths[index]! - 8)), height = Math.max(...lines.map((values) => values.length)) * 11 + 6; need(height); let x = margin; row.forEach((_, index) => { page.drawRectangle({ x, y: y - height, width: widths[index]!, height, borderColor: rgb(.75, .75, .75), borderWidth: .5, color: heading ? rgb(.86, .9, .95) : undefined }); lines[index]!.forEach((line, lineIndex) => page.drawText(line, { x: x + 4, y: y - 12 - lineIndex * 11, size: 9, font: heading || block.firstColBold && index === 0 ? bold : regular })); x += widths[index]!; }); y -= height; }; if (block.head) draw(block.head, true); for (const row of block.rows) draw(row, false); y -= 8; } }
  return Buffer.from(await pdf.save());
}

export async function loadExport(applicationId: string, requesterId: string | null): Promise<{ doc: ExportDoc; meta: ExportMeta; status: string } | null> {
  const result = await pool.query(`SELECT doc, status, submitted_by_id, submitted_by_name, submitted_at FROM credit_summaries_v2 WHERE application_id = $1`, [applicationId]); const row = result.rows[0]; if (!row) return null;
  const signerId = row.status === "submitted" ? row.submitted_by_id : requesterId; const user = signerId ? await pool.query(`SELECT first_name, last_name, email, phone_number FROM users WHERE id::text = $1 LIMIT 1`, [signerId]) : { rows: [] as any[] }; const name = [user.rows[0]?.first_name, user.rows[0]?.last_name].filter(Boolean).join(" ") || user.rows[0]?.email || null;
  return { doc: row.doc as ExportDoc, status: row.status, meta: { signedBy: row.status === "submitted" ? row.submitted_by_name ?? name : name, phone: user.rows[0]?.phone_number ?? null, date: row.submitted_at ? new Date(row.submitted_at) : new Date() } };
}
