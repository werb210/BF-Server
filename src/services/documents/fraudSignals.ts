// BF_SERVER_BLOCK_v_DOC_FRAUD_SIGNALS_v1 — explainable document tamper SIGNALS for
// staff review. This is deliberately NOT a verdict and never auto-rejects: it surfaces
// reasons a human should look closer. The scoring is pure + deterministic (tested);
// extractPdfMeta is the only side-effecting piece (parses a PDF buffer).
import { PDFDocument } from "pdf-lib";

export type DocKind = "bank_statement" | "tax_return" | "financials" | "other";

// Editing/authoring tools that have no business producing a BANK or CRA document.
// Intentionally NOT applied to financials — those are legitimately exported from
// Word/Excel, so flagging them on producer would wrongly accuse honest clients.
export const SUSPECT_PRODUCERS = [
  "photoshop", "gimp", "canva", "ilovepdf", "smallpdf", "sejda", "pdfescape",
  "pdf-xchange", "nitro", "foxit phantom", "word", "powerpoint", "google docs",
  "libreoffice", "openoffice", "pages",
];

export function classifyDocKind(category: string | null | undefined): DocKind {
  const c = String(category ?? "").toLowerCase();
  if (/bank|statement|chequing|checking|saving/.test(c)) return "bank_statement";
  if (/\btax\b|\bt1\b|\bt2\b|\bnoa\b|notice of assessment|\bcra\b/.test(c)) return "tax_return";
  if (/financ|p&l|pnl|profit|balance sheet|income statement|a\/r|a\/p|accountant/.test(c)) return "financials";
  return "other";
}

export type PdfMeta = {
  isPdf: boolean;
  parsed: boolean;
  producer: string | null;
  creator: string | null;
  createdAt: number | null; // epoch ms
  modifiedAt: number | null;
  incrementalSaves: number; // count of %%EOF markers; 1 = single clean save
  pageCount: number | null;
};

export async function extractPdfMeta(buffer: Buffer): Promise<PdfMeta> {
  const isPdf = buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-");
  const empty: PdfMeta = { isPdf, parsed: false, producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalSaves: 0, pageCount: null };
  if (!isPdf) return empty;
  const incrementalSaves = (buffer.toString("latin1").match(/%%EOF/g) || []).length;
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
    const cd = pdf.getCreationDate();
    const md = pdf.getModificationDate();
    return {
      isPdf: true,
      parsed: true,
      producer: pdf.getProducer() ?? null,
      creator: pdf.getCreator() ?? null,
      createdAt: cd ? cd.getTime() : null,
      modifiedAt: md ? md.getTime() : null,
      incrementalSaves,
      pageCount: pdf.getPageCount(),
    };
  } catch {
    return { ...empty, parsed: false, incrementalSaves };
  }
}

export type FraudSignal = { code: string; label: string; severity: "low" | "medium" | "high"; detail: string };
export type FraudResult = { level: "clean" | "low" | "medium" | "high"; signals: FraudSignal[]; note: string | null };

export function scoreFraudSignals(meta: PdfMeta, ctx: { kind: DocKind; duplicateCount: number }): FraudResult {
  const signals: FraudSignal[] = [];
  const prodLc = `${meta.producer ?? ""} ${meta.creator ?? ""}`.toLowerCase();

  if (ctx.duplicateCount > 0) {
    signals.push({ code: "duplicate_reuse", label: "Identical file seen on another application", severity: "high", detail: `This exact file (same hash) already appears on ${ctx.duplicateCount} other application(s).` });
  }

  if (ctx.kind === "bank_statement" || ctx.kind === "tax_return") {
    const hit = SUSPECT_PRODUCERS.find((p) => prodLc.includes(p));
    if (hit) signals.push({ code: "editor_producer", label: "Authored by editing software", severity: "high", detail: `PDF producer/creator references "${hit}" — a bank/CRA document should come straight from the source system, not an editor.` });
  }

  if (meta.incrementalSaves > 1) {
    const severity = ctx.kind === "financials" ? "low" : "medium";
    signals.push({ code: "incremental_saves", label: "Re-saved after creation", severity, detail: `The PDF has ${meta.incrementalSaves} save layers; an unedited bank statement is normally a single pass.` });
  }

  if (meta.createdAt != null && meta.modifiedAt != null && meta.modifiedAt - meta.createdAt > 60_000) {
    const severity = ctx.kind === "financials" ? "low" : "medium";
    const mins = Math.round((meta.modifiedAt - meta.createdAt) / 60_000);
    signals.push({ code: "modified_after_create", label: "Modified after creation", severity, detail: `Last modified ${mins} min after it was created.` });
  }

  if (meta.isPdf && !meta.parsed) {
    signals.push({ code: "unreadable_pdf", label: "PDF metadata unreadable", severity: "low", detail: "The PDF could not be parsed for metadata — review the file manually." });
  }
  if (!meta.isPdf) {
    signals.push({ code: "not_pdf", label: "Not a PDF — metadata checks skipped", severity: "low", detail: "File isn't a PDF, so tamper-metadata checks don't apply. Review the image manually." });
  }

  const level: FraudResult["level"] =
    signals.some((s) => s.severity === "high") ? "high"
    : signals.some((s) => s.severity === "medium") ? "medium"
    : signals.some((s) => s.severity === "low") ? "low"
    : "clean";

  const note = ctx.kind === "financials"
    ? "Accountant-prepared financials are legitimately exported from Word/Excel, so producer metadata is NOT treated as a fraud signal here. The reliable check for financials (internal math + revenue-vs-deposits) is a later pass — review manually."
    : null;

  return { level, signals, note };
}
