// BF_SERVER_v891_ONE_CALL_SCRIPT - Boreal's intake call is an ordinary, editable call script, the migration adds the
// same script, and the dialler script is a per-script choice an Admin makes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { borealIntakeScript, BOREAL_INTAKE_NAME } from "../borealIntake.js";
import { rowToScript, validateScript } from "../scripts.js";

const migration = readFileSync(path.resolve(process.cwd(), "migrations/2026_11_19_v891_one_call_script.sql"), "utf8");

describe("Boreal's intake call as a call script", () => {
  it("keeps every step the dialler used to show, in order", () => {
    const titles = borealIntakeScript().sections.map((s) => s.title);
    expect(titles[0]).toBe("Recording consent (read first)");
    expect(titles).toEqual(expect.arrayContaining(["Greeting", "Funding request", "Documents and secure link", "Close", "Agent notes"]));
    expect(titles).toHaveLength(15);
    const body = borealIntakeScript().sections.map((s) => s.body).join("\n");
    expect(body).toContain("This call is recorded for quality and accuracy. Is that okay to continue?");
    expect(body).toContain("$1M+ routes to the senior broker queue.");
  });

  it("passes the same checks as a script an Admin builds", async () => {
    const r = await validateScript({ query: vi.fn(answerBySql([])) }, borealIntakeScript(), "BF");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.dialer_default).toBe(true);
      expect(r.value.sections.flatMap((s) => s.questions).map((q) => q.id)).toEqual(borealIntakeScript().sections.flatMap((s) => s.questions).map((q) => q.id));
    }
  });

  it("the migration adds the same script to BF only, once, and only takes the dialler spot when it is free", () => {
    const json = /'(\[.*\])'::jsonb/s.exec(migration)?.[1];
    expect(json).toBeTruthy();
    expect(JSON.parse(json!.replace(/''/g, "'"))).toEqual(borealIntakeScript().sections);
    expect(migration).toContain(`'${BOREAL_INTAKE_NAME}'`);
    expect(migration).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM call_scripts WHERE silo = 'BF' AND lower\(name\)/);
    expect(migration).toMatch(/NOT EXISTS \(SELECT 1 FROM call_scripts WHERE silo = 'BF' AND dialer_default AND archived_at IS NULL\)/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS dialer_default/);
  });
});

describe("the dialler script choice", () => {
  it("is off unless asked for, and comes back on a script", async () => {
    const db = { query: vi.fn(answerBySql([])) };
    const base = { name: "Renewal", sections: [{ title: "Check-in", questions: [] }] };
    const off = await validateScript(db, base, "BF");
    expect(off.ok && off.value.dialer_default).toBe(false);
    const on = await validateScript(db, { ...base, dialer_default: true }, "BF");
    expect(on.ok && on.value.dialer_default).toBe(true);
    expect(rowToScript({ id: "x", silo: "BF", name: "n", use_for: "any", sections: [], dialer_default: true }).dialer_default).toBe(true);
    expect(rowToScript({ id: "x", silo: "BF", name: "n", use_for: "any", sections: [] }).dialer_default).toBe(false);
  });
});
