// BF_SERVER_BLOCK_v544_ACTION_CENTER_MATCHES_REQUEST_ITEMS
import { describe, expect, it } from "vitest";
import { assembleActionCenter } from "../applicantActions.js";

const base = { requestedForms: [], waivedForms: [], submittedFormTypes: [], required: [], stillNeeded: [], rejected: [] };

describe("v544 client to-do list matches staff Request Items", () => {
  it("does not list a form staff never requested, even if a draft exists", () => {
    const r = assembleActionCenter({ ...base, submittedFormTypes: [] });
    expect(r.outstanding.find((i) => i.key === "form:networth")).toBeUndefined();
  });
  it("lists a requested form until it is submitted", () => {
    const open = assembleActionCenter({ ...base, requestedForms: ["networth"] });
    expect(open.outstanding.map((i) => i.label)).toContain("Personal Net Worth");
    const done = assembleActionCenter({ ...base, requestedForms: ["networth"], submittedFormTypes: ["net_worth_statement"] });
    expect(done.outstanding).toHaveLength(0);
    expect(done.completed.map((i) => i.key)).toContain("form:networth");
  });
  it("drops a requested form that staff unchecked", () => {
    const r = assembleActionCenter({ ...base, requestedForms: ["networth", "cra"], waivedForms: ["networth"] });
    expect(r.outstanding.map((i) => i.key)).toEqual(["form:cra"]);
  });
  it("documents follow the waiver-aware upload list; rejected first", () => {
    const r = assembleActionCenter({
      ...base,
      required: [{ document_type: "a_r", label: "A/R" }, { document_type: "tax", label: "Tax returns" }],
      stillNeeded: [{ document_type: "tax", label: "Tax returns" }],
      rejected: [{ document_type: "id", label: "Government ID" }],
    });
    expect(r.outstanding.map((i) => i.label)).toEqual(["Government ID", "Tax returns"]);
    expect(r.outstanding[0].urgent).toBe(true);
    expect(r.completed.map((i) => i.label)).toEqual(["A/R"]);
    expect(r.outstandingCount).toBe(2);
  });
});
