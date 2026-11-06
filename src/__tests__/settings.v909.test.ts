// BF_SERVER_v909_SETTINGS - lending stage names / hidden / order (keys unchanged), available direct numbers, and the
// profile photo check.
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { PIPELINE_STATES } from "../modules/applications/pipelineState.js";
import { lendingPipeline, normalizeLendingDisplay } from "../pipelines/pipelines.js";
import { availableNumbers, mainLines } from "../voice/availableNumbers.js";
import { validProfileImage } from "../services/users.service.js";

describe("lending stage display (v909)", () => {
  it("renames, hides and reorders while every stage keeps its key", async () => {
    const display = { "Off to Lender": { label: "With lenders", position: 0 }, Hold: { hidden: true }, Received: { label: "Received", position: 2 } };
    const query = vi.fn(answerBySql([
      [(/key = \$1/), (_s: string, p?: unknown[]) => ({ rows: p![0] === "lending_pipeline_display" ? [{ value: display }] : [] })],
    ]));
    const p = await lendingPipeline({ query });
    expect(p.stages[0]).toMatchObject({ id: "Off to Lender", name: "Off to Lender", key: "Off to Lender", label: "With lenders" });
    expect(p.stages.find((s) => s.name === "Hold")).toMatchObject({ hidden: true, label: "Hold" });
    expect(p.stages.find((s) => s.name === "Received")!.label).toBe("Received");
    expect([...p.stages.map((s) => s.name)].sort()).toEqual([...PIPELINE_STATES].sort());
  });
  it("cleans what an Admin sends", () => {
    const v = normalizeLendingDisplay({ Received: { label: "  New   file ", hidden: "yes", position: 500 }, Bogus: { label: "x" } });
    expect(v.Received).toEqual({ label: "New file", hidden: false, position: 0 });
    expect(Object.keys(v)).toEqual(PIPELINE_STATES);
  });
});

describe("available direct numbers (v909)", () => {
  it("leaves out numbers someone has and the main lines", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ direct_number: "+18254511768" }] })) };
    const list = async () => [
      { phoneNumber: "+18254511768" }, { phoneNumber: "+18664440001" }, { phoneNumber: "+15875550123", friendlyName: "Edmonton 2" }, { phoneNumber: "+15875550123" },
    ];
    const out = await availableNumbers(db, list, { TWILIO_MAIN_LINE_NUMBER: "+1 866 444 0001" } as any);
    expect(out).toEqual([{ number: "+15875550123", label: "Edmonton 2" }]);
    expect([...mainLines({ TWILIO_FROM_NUMBER: "8664440001,+15875559999" } as any)]).toEqual(["+18664440001", "+15875559999"]);
  });
});

describe("profile photo (v909)", () => {
  it("accepts a small image or https URL, clears on null, refuses anything else", () => {
    expect(validProfileImage("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toEqual({ ok: true, value: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" });
    expect(validProfileImage("https://cdn.example.com/a.png")).toMatchObject({ ok: true });
    expect(validProfileImage(null)).toEqual({ ok: true, value: null });
    expect(validProfileImage("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(validProfileImage("data:image/png;base64," + "A".repeat(1_600_000))).toMatchObject({ ok: false });
  });
});
