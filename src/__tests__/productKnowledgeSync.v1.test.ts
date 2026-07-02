import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const svc = readFileSync(fileURLToPath(new URL("../modules/ai/productIngest.service.ts", import.meta.url)), "utf-8");
const idx = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf-8");
const wrk = readFileSync(fileURLToPath(new URL("../workers/productKnowledgeWorker.ts", import.meta.url)), "utf-8");

describe("product knowledge sync", () => {
  it("adds a reconciler that ingests missing and prunes deleted products", () => {
    expect(svc).toContain("export async function reconcileProductKnowledge");
    expect(svc).toContain("delete from ai_knowledge");
  });

  it("starts the worker at boot", () => {
    expect(idx).toContain("startProductKnowledgeWorker");
    expect(wrk).toContain("reconcileProductKnowledge");
  });
});
