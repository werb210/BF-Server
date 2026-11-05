// BF_SERVER_v871_CALL_SCRIPTS - call scripts: checking a script against the silo's custom fields, the starter intake
// scripts per silo, answers, the timeline summary and writing mapped answers to custom fields one at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { clearCustomFieldCache } from "../../customFields/service.js";
import { applyMappings, cleanAnswers, missingRequired, starterScripts, summaryText, validateScript, type Section } from "../scripts.js";

const C1 = "44444444-4444-4444-8444-444444444444";
const def = (name: string, silo: string, field_type = "text", options: unknown[] = []) => ({
  id: name, silo, object_type: "contact", name, label: name, field_type, options, required: false, group_name: null, description: null, sort_order: 0, archived_at: null,
});

beforeEach(() => clearCustomFieldCache());

describe("building a script", () => {
  it("needs a name, sections with titles, question labels and two choices for a pick list", async () => {
    const db = { query: vi.fn(answerBySql([])) };
    const r = await validateScript(db, { name: "", sections: [{ title: "", questions: [{ label: "", type: "single_select", options: ["Only one"] }] }] }, "BF");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["name", "sections.0.questions.0.label", "sections.0.questions.0.options", "sections.0.title"]);
  });

  it("an answer can be saved to an active custom field of the same silo only", async () => {
    const db = { query: vi.fn(answerBySql([
      [/FROM custom_field_definitions/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "contact" && p?.[1] === "BI" ? [def("lender_name", "BI")] : [] })],
    ])) };
    const body = (field: string) => ({ name: "PGI intake", sections: [{ title: "Guarantee", questions: [{ label: "Lender", type: "text", maps_to: { object: "contact", field } }] }] });
    const ok = await validateScript(db, body("lender_name"), "BI");
    expect(ok.ok && ok.value.sections[0]!.questions[0]!.maps_to).toEqual({ object: "contact", field: "lender_name" });
    clearCustomFieldCache();
    const wrongSilo = await validateScript(db, body("lender_name"), "BF");
    expect(!wrongSilo.ok && wrongSilo.errors["sections.0.questions.0.maps_to"]).toMatch(/no active contact custom field/);
  });
});

describe("starter intake scripts", () => {
  it("Boreal Financial gets its own intake call, then term loan, line of credit and equipment intakes", () => {
    const names = starterScripts("BF").map((s) => s.name);
    expect(names).toEqual(["Boreal intake call", "Intake - term loan", "Intake - line of credit", "Intake - equipment"]);
    expect(starterScripts("BF").every((s) => s.dialer_default === false)).toBe(true);
    const q = starterScripts("BF")[1]!.sections.flatMap((s) => s.questions).map((x) => x.label);
    expect(q).toEqual(expect.arrayContaining(["Months in business", "Average monthly revenue", "Amount requested", "Use of funds"]));
  });

  it("Boreal Insurance gets the personal guarantee insurance intake", () => {
    const [pgi, ...rest] = starterScripts("BI");
    expect(rest).toEqual([]);
    expect(pgi!.name).toBe("Intake - personal guarantee insurance");
    expect(pgi!.sections.flatMap((s) => s.questions).map((x) => x.label)).toContain("Lender holding the guarantee");
  });
});

const SECTIONS: Section[] = [{
  id: "s1", title: "The need", body: "", questions: [
    { id: "amt", label: "Amount requested", type: "money", options: [], required: true, help: "", maps_to: { object: "contact", field: "amount" } },
    { id: "use", label: "Use of funds", type: "single_select", options: ["Inventory", "Expansion"], required: false, help: "", maps_to: null },
    { id: "ok", label: "Profitable?", type: "yes_no", options: [], required: false, help: "", maps_to: { object: "application", field: "profitable" } },
    { id: "band", label: "Band", type: "single_select", options: ["A", "B"], required: false, help: "", maps_to: { object: "contact", field: "band" } },
  ],
}];

describe("answers", () => {
  it("keeps answers to the script's questions only, in the right shape", () => {
    expect(cleanAnswers(SECTIONS, { amt: "$250,000", use: "Holiday", ok: "yes", extra: "x" })).toEqual({ amt: 250000, ok: true });
    expect(missingRequired(SECTIONS, { use: "Inventory" })).toEqual(["Amount requested"]);
  });

  it("the timeline summary lists each answered question in Canadian dollars", () => {
    expect(summaryText(SECTIONS, { amt: 250000, ok: false })).toBe("The need\nAmount requested: $250,000.00\nProfitable?: No");
    expect(summaryText(SECTIONS, {})).toBe("No answers recorded.");
  });

  it("each mapped answer is written on its own: one refused value never loses the others", async () => {
    const db = { query: vi.fn(answerBySql([
      [/FROM custom_field_definitions/, { rows: [def("amount", "BF", "money"), def("band", "BF", "single_select", [{ value: "a", label: "A" }])] }],
      [/SELECT custom_fields, silo FROM contacts/, { rows: [{ custom_fields: {}, silo: "BF" }] }],
      [/UPDATE contacts SET custom_fields/, { rows: [{ custom_fields: { amount: 250000 } }] }],
    ])) };
    const r = await applyMappings(db, SECTIONS, { amt: 250000, ok: true, band: "C" }, { contactId: C1, applicationId: null });
    expect(r.updates).toEqual([{ object: "contact", field: "amount" }]);
    expect(r.errors.map((e) => e.field).sort()).toEqual(["band", "profitable"]);
    expect(r.errors.find((e) => e.field === "profitable")!.error).toMatch(/no application/);
    expect(callsMatching(db.query, /UPDATE contacts SET custom_fields/)).toHaveLength(1);
  });
});
