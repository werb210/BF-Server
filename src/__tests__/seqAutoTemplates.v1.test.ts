// BF_SERVER_SEQ_AUTO_TEMPLATES_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const engine = readFileSync(join(process.cwd(), "src", "services", "sequenceEngine.ts"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "routes", "marketing.ts"), "utf-8");
const migration = readFileSync(join(process.cwd(), "migrations", "2026_07_30_seq_auto_channel_templates_v1.sql"), "utf-8");

describe("an auto step uses the template written for the branch it takes", () => {
  it("defers template resolution until textability is known", () => {
    expect(engine).toContain('if (step.channel !== "auto") await applyTemplate(step.template_id);');
    expect(engine).toContain('await applyTemplate(channel === "sms" ? step.sms_template_id : step.email_template_id);');
  });
  it("resolves the branch before loading the template, not after", () => {
    const branchAt = engine.indexOf('const channel = step.channel === "auto"');
    const loadAt = engine.indexOf('await applyTemplate(channel === "sms"');
    expect(branchAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(branchAt);
  });
  it("reads both new columns from the steps query", () => {
    expect(engine).toContain("template_id, sms_template_id, email_template_id");
  });
  it("leaves single-channel steps on template_id", () => {
    // email / sms / task steps are unaffected by the split.
    expect(engine).toContain('if (step.channel !== "auto") await applyTemplate(step.template_id);');
  });
});

describe("the columns persist and read back", () => {
  it("inserts both, uuid-guarded", () => {
    expect(routes).toContain("uuidOrNull(st.smsTemplateId ?? st.sms_template_id)");
    expect(routes).toContain("uuidOrNull(st.emailTemplateId ?? st.email_template_id)");
    expect(routes).toContain("/^[0-9a-fA-F-]{36}$/.test(v.trim())");
  });
  it("returns them when a sequence is read back", () => {
    const seg = routes.slice(routes.indexOf("SELECT step_order, channel, wait_minutes"));
    expect(seg.slice(0, 300)).toContain("sms_template_id, email_template_id");
  });
  it("adds the columns idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS sms_template_id");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS email_template_id");
  });
});
