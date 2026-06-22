import { describe, it, expect } from "vitest";
import { classifyDocKind, scoreFraudSignals, type PdfMeta } from "../fraudSignals.js";

const clean: PdfMeta = { isPdf: true, parsed: true, producer: "RBC Royal Bank", creator: "RBC Royal Bank", createdAt: 1000, modifiedAt: 1000, incrementalSaves: 1, pageCount: 6 };

describe("classifyDocKind", () => {
  it("classifies bank statements", () => {
    expect(classifyDocKind("6 months business banking statements")).toBe("bank_statement");
    expect(classifyDocKind("chequing")).toBe("bank_statement");
  });
  it("classifies tax + financials + other", () => {
    expect(classifyDocKind("2 years personal tax returns (T1 generals)")).toBe("tax_return");
    expect(classifyDocKind("accountant prepared financials")).toBe("financials");
    expect(classifyDocKind("void cheque")).toBe("other");
  });
});

describe("scoreFraudSignals", () => {
  it("is clean for a single-pass bank statement from the bank's system", () => {
    const r = scoreFraudSignals(clean, { kind: "bank_statement", duplicateCount: 0 });
    expect(r.level).toBe("clean");
    expect(r.signals).toHaveLength(0);
  });

  it("flags a duplicate reuse as high regardless of kind", () => {
    const r = scoreFraudSignals(clean, { kind: "bank_statement", duplicateCount: 2 });
    expect(r.level).toBe("high");
    expect(r.signals.some((s) => s.code === "duplicate_reuse")).toBe(true);
  });

  it("flags an editor-authored bank statement as high", () => {
    const meta = { ...clean, producer: "Adobe Photoshop 25.0" };
    const r = scoreFraudSignals(meta, { kind: "bank_statement", duplicateCount: 0 });
    expect(r.level).toBe("high");
    expect(r.signals.some((s) => s.code === "editor_producer")).toBe(true);
  });

  it("does NOT flag Word-authored financials on producer, and adds the financials note", () => {
    const meta = { ...clean, producer: "Microsoft Word", incrementalSaves: 1, modifiedAt: 1000 };
    const r = scoreFraudSignals(meta, { kind: "financials", duplicateCount: 0 });
    expect(r.signals.some((s) => s.code === "editor_producer")).toBe(false);
    expect(r.level).toBe("clean");
    expect(r.note).toContain("financials");
  });

  it("flags incremental re-saves on a bank statement as medium", () => {
    const meta = { ...clean, incrementalSaves: 3 };
    const r = scoreFraudSignals(meta, { kind: "bank_statement", duplicateCount: 0 });
    expect(r.level).toBe("medium");
    expect(r.signals.some((s) => s.code === "incremental_saves")).toBe(true);
  });

  it("flags modified-long-after-create", () => {
    const meta = { ...clean, createdAt: 1000, modifiedAt: 1000 + 10 * 60_000 };
    const r = scoreFraudSignals(meta, { kind: "bank_statement", duplicateCount: 0 });
    expect(r.signals.some((s) => s.code === "modified_after_create")).toBe(true);
  });

  it("notes when the file is not a PDF", () => {
    const meta: PdfMeta = { ...clean, isPdf: false, parsed: false, producer: null, creator: null };
    const r = scoreFraudSignals(meta, { kind: "bank_statement", duplicateCount: 0 });
    expect(r.signals.some((s) => s.code === "not_pdf")).toBe(true);
  });
});
