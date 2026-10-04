// BF_SERVER_STORE_REVIEW_TEST_v734
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { quarantineReviewRecords } from "../services/reviewLogin.js";

afterEach(() => { delete process.env.REVIEW_LOGIN_PHONE; delete process.env.REVIEW_LOGIN_CODE; });

describe("store reviewer test records", () => {
  it("does nothing unless the review login is configured", async () => {
    const q = vi.fn(async () => ({}));
    expect(await quarantineReviewRecords(q)).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });
  it("moves the reviewer's contacts and applications to the TEST silo", async () => {
    process.env.REVIEW_LOGIN_PHONE = "+18255550199"; process.env.REVIEW_LOGIN_CODE = "864213";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const q = vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return {}; });
    expect(await quarantineReviewRecords(q)).toBe(true);
    expect(calls[0]!.sql).toContain("SET silo = 'TEST'");
    expect(calls[0]!.params).toEqual(["8255550199"]);
    expect(calls[1]!.sql).toContain("jsonb_build_object('store_review', true)");
  });
  it("runs at reviewer sign-in and after a submission has finished, never mid-request", () => {
    expect(readFileSync("src/routes/auth.ts", "utf8")).toContain("BF_SERVER_STORE_REVIEW_TEST_v734");
    const submit = readFileSync("src/routes/client/v1Applications.ts", "utf8");
    expect(submit).toContain("}, 30_000).unref?.();");
    expect(submit).not.toContain("await import(\"../../services/reviewLogin.js\")");
    expect(readFileSync("src/routes/publicApplication.ts", "utf8")).not.toContain("quarantineReviewRecords");
  });
  it("removes the reviewer's tasks from the queues", async () => {
    process.env.REVIEW_LOGIN_PHONE = "+18255550199"; process.env.REVIEW_LOGIN_CODE = "864213";
    const sqls: string[] = [];
    await quarantineReviewRecords(async (sql: string) => { sqls.push(sql); return {}; });
    expect(sqls[2]).toContain("UPDATE tasks SET deleted_at = now()");
  });
});
