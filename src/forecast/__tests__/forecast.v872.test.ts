// BF_SERVER_v872_FORECAST - periods, categories, the roll-up maths and batch 3's probabilities as the stage chances.
import { describe, expect, it, vi } from "vitest";
import { buildPeriods, categoryFor, computeForecast, loadProbabilities, monthsIn, saveProbabilities, setFileForecast, sumBuckets } from "../forecast.js";

const PROBABILITIES: Record<string, number> = { "Received": 10, "In Review": 25, "Documents Required": 15, "Additional Steps Required": 15, "Off to Lender": 40, "Offer": 70, "Accepted": 85 };

describe("periods", () => {
  it("months and quarters, across a year end", () => {
    expect(buildPeriods("month", "2026-11", 3).map((p) => [p.key, p.label, p.start, p.end])).toEqual([
      ["2026-11", "Nov 2026", "2026-11-01", "2026-12-01"], ["2026-12", "Dec 2026", "2026-12-01", "2027-01-01"], ["2027-01", "Jan 2027", "2027-01-01", "2027-02-01"],
    ]);
    const q = buildPeriods("quarter", "2026-11", 2);
    expect(q.map((p) => [p.key, p.start, p.end])).toEqual([["2026-Q4", "2026-10-01", "2027-01-01"], ["2027-Q1", "2027-01-01", "2027-04-01"]]);
    expect(monthsIn(q[0]!)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
  });

  it("category: staff choice wins, else from the stage's chance", () => {
    expect(categoryFor(85, null)).toBe("commit");
    expect(categoryFor(40, null)).toBe("best_case");
    expect(categoryFor(10, null)).toBe("pipeline");
    expect(categoryFor(10, "commit")).toBe("commit");
    expect(categoryFor(85, "omit")).toBe("omit");
    expect(categoryFor(85, "bogus")).toBe("commit");
  });
});

describe("the forecast roll-up", () => {
  const periods = buildPeriods("month", "2026-11", 2);
  const r = computeForecast({
    periods, today: "2026-11-10", probabilities: PROBABILITIES,
    closed: [{ owner: "u1", day: "2026-11-03", commission: 2000, amount: 100000 }, { owner: "u1", day: "2026-10-30", commission: 999, amount: 1 }],
    open: [
      { id: "a", name: "A", owner: "u1", stage: "Accepted", close: "2026-11-20", category_override: null, commission: 1000, amount: 50000 }, // commit 85%
      { id: "b", name: "B", owner: "u1", stage: "Off to Lender", close: "2026-11-25", category_override: null, commission: 1000, amount: 50000 }, // best case 40%
      { id: "c", name: "C", owner: "u1", stage: "Received", close: "2026-12-05", category_override: null, commission: 1000, amount: 50000 }, // pipeline 10%
      { id: "d", name: "D", owner: "u2", stage: "Offer", close: "2026-10-15", category_override: null, commission: 500, amount: 1 }, // overdue -> Nov
      { id: "e", name: "E", owner: "u2", stage: "Offer", close: null, category_override: null, commission: 700, amount: 1 }, // not scheduled
      { id: "f", name: "F", owner: "u2", stage: "Offer", close: "2026-11-15", category_override: "omit", commission: 900, amount: 1 }, // left out
      { id: "g", name: "G", owner: "u3", stage: "Signed LOI", close: "2026-12-10", category_override: null, commission: 1000, amount: 1, probability: 50 }, // custom pipeline stage
    ],
    goals: [{ user_id: "u1", month: "2026-11-01", commission: 5000, funding: 250000 }],
  });
  const u1 = r.byOwner.find((o) => o.owner === "u1")!;
  const u2 = r.byOwner.find((o) => o.owner === "u2")!;

  it("each category includes the ones before it", () => {
    expect(u1.periods[0]).toMatchObject({ closed: 2000, commit: 3000, best_case: 4000, pipeline: 4000, weighted: 2000 + 850 + 400, closed_amount: 100000, files: 2, goal_commission: 5000, goal_funding: 250000 });
    expect(u1.periods[1]).toMatchObject({ closed: 0, commit: 0, best_case: 0, pipeline: 1000, weighted: 100, goal_commission: null });
  });

  it("overdue counts now; no date is not scheduled; omit is left out but still listed", () => {
    expect(u2.periods[0]).toMatchObject({ commit: 500, pipeline: 500, weighted: 350, files: 1 });
    expect(r.overdue).toBe(1);
    expect(r.unscheduled).toEqual({ files: 1, pipeline: 700, weighted: 490 });
    expect(r.deals.find((d) => d.id === "f")).toMatchObject({ category: "omit" });
    expect(r.deals.find((d) => d.id === "d")).toMatchObject({ overdue: true, period: "2026-11" });
  });

  it("a custom pipeline stage uses its own chance", () => {
    expect(r.deals.find((d) => d.id === "g")).toMatchObject({ probability: 50, category: "best_case", weighted: 500 });
    expect(r.byOwner.find((o) => o.owner === "u3")!.periods[1]).toMatchObject({ best_case: 1000, weighted: 500 });
  });

  it("sums for teams and totals", () => {
    const t = sumBuckets([u1.periods[0]!, u2.periods[0]!]);
    expect(t).toMatchObject({ closed: 2000, commit: 3500, pipeline: 4500, goal_commission: 5000 });
  });
});

/** The batch 3 settings row and the application, answered by SQL content. */
function settingsDb(initial: Record<string, number> | null) {
  let value: unknown = initial;
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (/SELECT value FROM boreal_settings WHERE key = \$1/.test(sql) && p[0] === "lending_pipeline_probabilities") return { rows: value ? [{ value }] : [] };
    if (/INSERT INTO boreal_settings/.test(sql)) { value = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1]; return { rows: [] }; }
    if (/UPDATE applications SET/.test(sql)) return { rows: p[0] === "app-1" ? [{ id: "app-1", expected_close_date: p[1] ?? null, forecast_category: p[2] ?? null, pipeline_state: "Offer" }] : [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
  return { query, get value() { return value; } };
}

describe("stage chances are batch 3's pipeline probabilities", () => {
  it("reads the lending probabilities (defaults until an Admin sets them)", async () => {
    expect(await loadProbabilities(settingsDb(null) as any)).toMatchObject({ Received: 10, Offer: 75, Accepted: 90, Funded: 100 });
    expect(await loadProbabilities(settingsDb({ Received: 5, Offer: 60 }) as any)).toMatchObject({ Received: 5, Offer: 60, Accepted: 90 });
  });

  it("an edit here changes the same numbers the pipeline board weights by, other stages kept", async () => {
    const db = settingsDb({ Received: 5, Offer: 60, Hold: 0 });
    expect(await saveProbabilities(db as any, { Offer: 80 }, null)).toEqual({ ok: true });
    expect(db.value).toMatchObject({ Received: 5, Offer: 80 });
    expect((await saveProbabilities(db as any, { Funded: 50 }, null)).ok).toBe(false);
    expect((await saveProbabilities(db as any, { Offer: 101 }, null)).ok).toBe(false);
  });

  it("a file's close date and category are checked", async () => {
    const db = settingsDb(null);
    expect(await setFileForecast(db as any, "app-1", { expected_close_date: "2026-13-40" })).toMatchObject({ ok: false, status: 400 });
    expect(await setFileForecast(db as any, "app-1", { forecast_category: "maybe" })).toMatchObject({ ok: false, status: 400 });
    expect(await setFileForecast(db as any, "app-1", {})).toMatchObject({ ok: false, error: "nothing_to_change" });
    expect(await setFileForecast(db as any, "app-1", { expected_close_date: "2026-12-15", forecast_category: "commit" })).toMatchObject({ ok: true });
  });
});
