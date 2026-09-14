// BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("src/workers/inboundAttachmentWorker.ts", "utf-8");
const service = readFileSync("src/services/contactDocuments.ts", "utf-8");
const migration = readFileSync("migrations/2026_09_15_v189_inbound_attachment_attempts.sql", "utf-8");

describe("inbound attachment attempt ledger", () => {
  it("consults the ledger in both scan loops, not just the /me one", () => {
    expect(worker.match(/shouldSkipMessage\(pool, silo, mid\)/g)).toHaveLength(2);
    expect(worker.match(/recordAttempt\(pool, silo, mid,/g)).toHaveLength(4);
  });

  it("caps retries so a message that files nothing is eventually left alone", () => {
    expect(worker).toContain("MAX_ATTEMPTS = 3");
    expect(worker).toMatch(/attempts \?\? 0\) >= MAX_ATTEMPTS/);
  });

  it("treats a filed or terminal message as permanently done", () => {
    expect(worker).toMatch(/last_outcome === "filed" \|\| row\.last_outcome === "terminal"/);
  });

  it("never lets a ledger failure change the scan's behaviour", () => {
    const fn = worker.slice(worker.indexOf("async function shouldSkipMessage"));
    expect(fn.slice(0, fn.indexOf("async function recordAttempt"))).toContain("return false; // ledger unavailable");
  });
});

describe("skip classification", () => {
  it("separates permanent skips from transient ones", () => {
    expect(service).toContain("permanentSkips++");
    expect(service).toContain("transientSkips++");
  });

  it("only marks a message retryable when a retry could actually help", () => {
    expect(service).toMatch(
      /const retryable = filed === 0 && duplicates === 0 && transientSkips > 0;/,
    );
  });

  it("logs the real status when the by-id attachment fetch fails", () => {
    expect(service).toContain("attachment fetch by id failed");
    expect(service).toContain("status: one.status");
  });
});

describe("migration", () => {
  it("is idempotent", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS inbound_attachment_attempts");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("keys on silo and message id together", () => {
    expect(migration).toContain("PRIMARY KEY (silo, message_id)");
  });
});
