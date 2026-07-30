// BF_SERVER_SEQ_AUDIENCE_TAGS_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const engine = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");
const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_audience_tags_v1.sql"), "utf-8");

describe("sequence audience include and exclude tags", () => {
  it("adds both columns idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS audience_include_tags");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS audience_exclude_tags");
  });

  it("accepts composer-style tag lists and preserves the legacy tag", () => {
    expect(routes).toContain("tagList(b.includeTags ?? b.audienceIncludeTags)");
    expect(routes).toContain("tagList(b.excludeTags ?? b.audienceExcludeTags)");
    expect(routes).toContain("b.audienceTag ? String(b.audienceTag) : null");
  });

  it("returns the lists when a sequence is read", () => {
    expect(routes).toContain("audience_tag, audience_include_tags, audience_exclude_tags, status");
  });

  it("uses union include matching and lets exclude win", () => {
    expect(engine).toContain("COALESCE(c.tags, '{}') && $4::text[]");
    expect(engine).toContain("NOT (COALESCE(c.tags, '{}') && $5::text[])");
  });

  it("treats an empty include list as no filter and folds in audience_tag", () => {
    expect(engine).toContain("cardinality($4::text[]) = 0");
    expect(engine).toContain("seq.rows[0].audience_tag ? [seq.rows[0].audience_tag] : []");
  });
});
