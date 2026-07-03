// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - branded email audience:
// include empty = all contacts with email; include = ANY-of tags via array
// overlap; exclude removes ANY-of and wins over include; big blasts carry the
// arrays through the queue payload so the worker applies the same filter.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runner = readFileSync(join(process.cwd(), "src", "services", "marketingSendRunner.ts"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");
const worker = readFileSync(join(process.cwd(), "src", "workers", "sendQueueWorker.ts"), "utf-8");

describe("email audience include/exclude", () => {
  it("runner filters by array overlap for include and NOT-overlap for exclude", () => {
    expect(runner).toContain("COALESCE(c.tags,'{}') && $3");
    expect(runner).toContain("NOT (COALESCE(c.tags,'{}') && $4)");
    expect(runner).toContain("excludeTags?: string[] | null");
  });
  it("send-template accepts tags/excludeTags and forwards them inline and via queue payload", () => {
    expect(routes).toContain("const includeTags = tagArr(b.tags);");
    expect(routes).toContain("const excludeTags = tagArr(b.excludeTags);");
    expect(routes).toContain("tags: includeTags, excludeTags");
  });
  it("exposes a live audience-count endpoint for the composer preview", () => {
    expect(routes).toContain('\"/email/audience-count\"');
  });
  it("queue worker passes the arrays back into the runner", () => {
    expect(worker).toContain("excludeTags: (p.excludeTags as string[] | undefined) ?? null");
  });
});
