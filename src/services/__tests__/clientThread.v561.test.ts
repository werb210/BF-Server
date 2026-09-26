// BF_SERVER_BLOCK_v561
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __clearPgiStageCache, pgiDone, pgiStageFor } from "../pgiStage.js";

beforeEach(() => __clearPgiStageCache());

describe("v561 PGI prompt", () => {
  it("is done once the PGI application has moved past new_application", () => {
    expect(pgiDone(null)).toBe(false);
    expect(pgiDone("new_application")).toBe(false);
    expect(pgiDone("documents_pending")).toBe(true);
    expect(pgiDone("policy_issued")).toBe(true);
  });
  it("looks the stage up once per 5 minutes and treats failures as not done", async () => {
    const fetchStage = vi.fn(async () => "under_review");
    const deps = { biPublicId: async () => "BI-1", fetchStage, now: () => 1000 };
    expect(await pgiStageFor("a1", deps)).toBe("under_review");
    await pgiStageFor("a1", deps);
    expect(fetchStage).toHaveBeenCalledTimes(1);
    expect(await pgiStageFor("a2", { ...deps, fetchStage: async () => { throw new Error("down"); } })).toBeNull();
    expect(await pgiStageFor("a3", { ...deps, biPublicId: async () => null })).toBeNull();
  });
});

describe("v561 client thread", () => {
  const route = readFileSync("src/routes/client/index.ts", "utf-8");
  it("decides 'documents all in' from the live upload list", () => {
    expect(route).toContain("const o = await computeOutstandingDocs(applicationId);");
    expect(route).toContain('if (v561_docsClear) v778_completed.add("upload_docs");');
  });
  it("drops finished checklist notes and the finished PGI prompt", () => {
    expect(route).toContain("We've added more documents to your checklist|To continue your application, please upload");
    expect(route).toContain('r.cta_label !== "Complete PGI Application"');
  });
});
