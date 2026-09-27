// BF_SERVER_BLOCK_v618 - enrollment and step runner.
import { describe, it, expect, vi } from "vitest";
import { emitWith, runEnrollment, type EngineDeps } from "../automationEngine.js";

const NOON = new Date("2026-09-28T18:00:00Z"); // 12:00 in Edmonton

function harness(opts: { rules?: any[]; priorEnrollment?: boolean; stage?: string; docStatus?: string; now?: Date; failTask?: number } = {}) {
  const enrollments: any[] = [];
  const log: any[] = [];
  const tasks: any[] = [];
  const sms: any[] = [];
  let taskFailures = opts.failTask ?? 0;
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes("FROM applications a WHERE a.id::text")) return { rows: [{ id: "app-1", silo: "BF", contact_id: "c-1", pipeline_state: opts.stage ?? "Offer", product_type: "term_loan", requested_amount: "250000", source: "website", owner_user_id: "u-1" }] };
    if (sql.includes("FROM contacts c LEFT JOIN users u")) return { rows: [{ id: "c-1", silo: "BF", name: "Pat Lee", first_name: "Pat", phone: "+17805551212", tags: ["vip"], owner_id: "u-1", owner_first: "Andrew", owner_last: "M" }] };
    if (sql.includes("FROM automation_rules WHERE enabled")) return { rows: opts.rules ?? [] };
    if (sql.includes("FROM automation_enrollments") && sql.includes("LIMIT 1") && sql.includes("rule_id = $1::uuid")) return { rows: opts.priorEnrollment ? [{ x: 1 }] : [] };
    if (sql.startsWith("INSERT INTO automation_enrollments")) { const e = { id: `e-${enrollments.length + 1}`, rule_id: p[0], silo: p[2], contact_id: p[3], application_id: p[4], context: JSON.parse(p[5]), steps: JSON.parse(p[6]), test_mode: p[7], current_step: 0, attempts: 0, status: "active", created_at: "2026-09-28T00:00:00Z" }; enrollments.push(e); return { rows: [{ id: e.id }] }; }
    if (sql.startsWith("UPDATE automation_enrollments SET locked_until")) { const e = enrollments.find((x) => x.id === p[0] && x.status === "active"); return { rows: e ? [e] : [] }; }
    if (sql.startsWith("UPDATE automation_enrollments SET")) {
      const e = enrollments.find((x) => x.id === p[0]);
      if (e) {
        if (sql.includes("status = 'completed'")) { e.status = "completed"; e.current_step = p[1]; }
        else if (sql.includes("status = 'stopped'")) { e.status = "stopped"; }
        else if (sql.includes("status = 'failed'")) { e.status = "failed"; e.attempts = p[1]; }
        else if (sql.includes("next_run_at = now() + interval '15 minutes'")) { e.attempts = p[1]; e.retry = true; }
        else if (sql.includes("next_run_at = $3")) { e.current_step = p[1]; e.next_run_at = p[2]; e.status = "active"; e.parked = true; }
        else { e.current_step = p[1]; }
      }
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO automation_step_log")) { log.push({ step: p[3], outcome: p[4], detail: p[5] }); return { rows: [] }; }
    if (sql.startsWith("INSERT INTO crm_timeline_events")) return { rows: [] };
    if (sql.startsWith("INSERT INTO tasks")) { if (taskFailures > 0) { taskFailures--; throw new Error("db down"); } tasks.push({ title: p[1], type: p[3], hours: p[5] }); return { rows: [{ id: `t-${tasks.length}` }] }; }
    if (sql.includes("SELECT pipeline_state FROM applications")) return { rows: [{ pipeline_state: opts.stage ?? "Offer" }] };
    if (sql.includes("SELECT status FROM documents")) return { rows: [{ status: opts.docStatus ?? "rejected" }] };
    if (sql.includes("SELECT c.phone FROM contacts c")) return { rows: [{ phone: "+17805551212" }] };
    return { rows: [] };
  });
  const deps: EngineDeps = {
    query: query as any,
    sendSms: vi.fn(async (to: string, m: string) => { sms.push({ to, m }); }),
    notifyClient: vi.fn(async () => "app" as const),
    now: () => opts.now ?? NOON,
  };
  return { deps, enrollments, log, tasks, sms, query };
}

describe("enrollment and steps", () => {
  const rule = (steps: any[], extra: any = {}) => ({ id: "r-1", conditions: [{ field: "to_stage", op: "eq", value: "Offer" }], steps, actions: [], reenroll: "never", test_mode: false, version: 1, ...extra });

  it("enrolls only matching rules, once unless re-enrollment is allowed", async () => {
    const h = harness({ rules: [rule([{ type: "create_task", title: "x" }]), { ...rule([{ type: "create_task", title: "y" }]), id: "r-2", conditions: [{ field: "to_stage", op: "eq", value: "Accepted" }] }] });
    expect(await emitWith(h.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" })).toHaveLength(1);
    expect(h.enrollments[0].context).toMatchObject({ first_name: "Pat", silo: "BF", contact_id: "c-1", requested_amount: 250000, owner_name: "Andrew M" });
    const again = harness({ rules: [rule([{ type: "create_task", title: "x" }])], priorEnrollment: true });
    expect(await emitWith(again.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" })).toHaveLength(0);
  });

  it("runs a task, waits, re-checks and continues or stops", async () => {
    const steps = [{ type: "create_task", title: "Call {{first_name}}", taskType: "CALL", dueHours: 1 }, { type: "wait", amount: 48, unit: "hours" }, { type: "check", check: "still_in_stage" }, { type: "send_sms", purpose: "transactional", body: "Hi {{first_name}}" }];
    const h = harness({ rules: [rule(steps)] });
    const [id] = await emitWith(h.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" });
    expect(await runEnrollment(h.deps, id)).toBe("waiting");
    expect(h.tasks).toEqual([{ title: "Call Pat", type: "CALL", hours: "1" }]);
    expect(h.enrollments[0].current_step).toBe(2);
    expect(await runEnrollment(h.deps, id)).toBe("completed");
    expect(h.sms).toEqual([{ to: "+17805551212", m: "Hi Pat" }]);

    const moved = harness({ rules: [rule(steps)], stage: "Accepted" });
    const [id2] = await emitWith(moved.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" });
    await runEnrollment(moved.deps, id2);
    expect(await runEnrollment(moved.deps, id2)).toBe("stopped");
    expect(moved.sms).toHaveLength(0);
  });

  it("test mode logs what would happen and does nothing", async () => {
    const h = harness({ rules: [rule([{ type: "create_task", title: "x" }, { type: "send_sms", body: "hi" }], { test_mode: true })] });
    const [id] = await emitWith(h.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" });
    expect(await runEnrollment(h.deps, id)).toBe("completed");
    expect(h.tasks).toHaveLength(0);
    expect(h.sms).toHaveLength(0);
    expect(h.log.map((l) => l.outcome)).toEqual(["dry_run", "dry_run"]);
  });

  it("holds texts in quiet hours and retries failures, then gives up", async () => {
    const night = harness({ rules: [rule([{ type: "send_sms", body: "hi" }])], now: new Date("2026-09-29T04:30:00Z") });
    const [id] = await emitWith(night.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" });
    expect(await runEnrollment(night.deps, id)).toBe("quiet_hours");
    expect(night.sms).toHaveLength(0);

    const flaky = harness({ rules: [rule([{ type: "create_task", title: "x" }])], failTask: 5 });
    const [id3] = await emitWith(flaky.deps, { trigger: "application.stage_changed", applicationId: "app-1", toStage: "Offer" });
    expect(await runEnrollment(flaky.deps, id3)).toBe("retry");
    expect(await runEnrollment(flaky.deps, id3)).toBe("retry");
    expect(await runEnrollment(flaky.deps, id3)).toBe("failed");
  });

});
