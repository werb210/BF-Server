import { describe, it, expect, vi, beforeEach } from "vitest";

const sendSmsMock = vi.fn();
vi.mock("../../../src/services/smsService.js", () => ({
  sendSMS: (...args: unknown[]) => sendSmsMock(...args),
}));

import { notifyAdminsForCreditSummary } from "../../../src/services/notifications/notifyAdminsForCreditSummary";

function fakePool(handler: (sql: string, args: unknown[]) => unknown[]): any {
  return { query: vi.fn(async (sql: string, args: unknown[] = []) => ({ rows: handler(sql, args) })) };
}

beforeEach(() => {
  sendSmsMock.mockReset();
  sendSmsMock.mockResolvedValue({ success: true });
});

describe("notifyAdminsForCreditSummary", () => {
  it("sends SMS + in-app notification to every active Admin", async () => {
    const inserted: any[] = [];
    const pool = {
      query: vi.fn(async (sql: string, args: unknown[] = []) => {
        if (sql.includes("FROM applications WHERE id::text = $1 LIMIT 1")) {
          return { rows: [{ name: "Acme Corp", requested_amount: 250000 }] };
        }
        if (sql.includes("FROM users")) {
          return {
            rows: [
              { id: "u-admin-1", phone_number: "+15555550001", email: "a1@x.com" },
              { id: "u-admin-2", phone_number: "+15555550002", email: "a2@x.com" },
            ],
          };
        }
        if (sql.startsWith("INSERT INTO notifications") || sql.includes("INSERT INTO notifications")) {
          inserted.push(args);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    } as any;

    const r = await notifyAdminsForCreditSummary({ pool, applicationId: "app-1" });
    expect(r.smsSent).toBe(2);
    expect(r.notifsCreated).toBe(2);
    expect(sendSmsMock).toHaveBeenCalledTimes(2);
    expect(sendSmsMock.mock.calls[0]?.[0]).toBe("+15555550001");
    expect(sendSmsMock.mock.calls[0]?.[1]).toMatch(/Acme Corp/);
    expect(sendSmsMock.mock.calls[0]?.[1]).toMatch(/\$250,000/);
    expect(inserted.length).toBe(2);
  });

  it("skips admins with no phone but still creates an in-app notification", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("FROM applications WHERE id::text = $1 LIMIT 1")) {
        return [{ name: null, requested_amount: null }];
      }
      if (sql.includes("FROM users")) {
        return [{ id: "u-admin-3", phone_number: null, email: "a3@x.com" }];
      }
      if (sql.includes("INSERT INTO notifications")) return [];
      return [];
    });
    const r = await notifyAdminsForCreditSummary({ pool, applicationId: "app-x" });
    expect(r.smsSent).toBe(0);
    expect(r.notifsCreated).toBe(1);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("never throws when SMS or insert fails", async () => {
    sendSmsMock.mockRejectedValue(new Error("twilio_down"));
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM applications WHERE id::text = $1 LIMIT 1")) {
          return { rows: [{ name: "X", requested_amount: 0 }] };
        }
        if (sql.includes("FROM users")) {
          return { rows: [{ id: "u1", phone_number: "+15555550003", email: null }] };
        }
        if (sql.includes("INSERT INTO notifications")) {
          throw new Error("table_locked");
        }
        return { rows: [] };
      }),
    } as any;
    await expect(
      notifyAdminsForCreditSummary({ pool, applicationId: "app-x" })
    ).resolves.toEqual({ smsSent: 0, notifsCreated: 0 });
  });

  it("returns 0/0 when no admins exist", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("FROM applications WHERE id::text = $1 LIMIT 1")) {
        return [{ name: "X", requested_amount: 0 }];
      }
      if (sql.includes("FROM users")) return [];
      return [];
    });
    const r = await notifyAdminsForCreditSummary({ pool, applicationId: "app-x" });
    expect(r).toEqual({ smsSent: 0, notifsCreated: 0 });
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});
