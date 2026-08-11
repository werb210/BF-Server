// BF_SERVER_SENT_ITEMS_v39
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SENT_LOGGED_HEADER,
  addressesOf,
  externalRecipients,
  logSentMessage,
  wasLoggedAtSendTime,
} from "../../modules/o365/sentItemsLog.js";

const subs = readFileSync(path.join(process.cwd(), "src/modules/o365/mailSubscriptions.ts"), "utf8");
const send = readFileSync(path.join(process.cwd(), "src/routes/o365.ts"), "utf8");
const appleMail = {
  id: "AAMk-sent-1",
  subject: "After our call",
  from: { emailAddress: { address: "todd.w@boreal.financial" } },
  toRecipients: [{ emailAddress: { address: "Gifford@example.com" } }],
};

describe("mail sent outside the portal reaches the timeline", () => {
  it("subscribes to sent items as well as the inbox", () => {
    expect(subs).toContain(`const SENT_RESOURCE = "me/mailFolders('sentitems')/messages"`);
    expect(subs).toContain("await ensureMailSubscription(pool, u.id, SENT_RESOURCE);");
  });
  it("looks for an existing subscription per folder, not per user", () => {
    expect(subs).toContain("WHERE user_id = $1 AND resource = $2");
  });
  it("logs a sent message instead of raising a new-mail alert", () => {
    expect(subs).toContain("if (sub.resource === SENT_RESOURCE) {");
    expect(subs).toContain("await logSentMessage(pool, sub.user_id, message)");
  });
});

describe("the same email is never logged twice", () => {
  it("the portal stamps mail it has already logged", () => {
    expect(send).toContain('internetMessageHeaders: [{ name: SENT_LOGGED_HEADER, value: "1" }]');
  });
  it("a stamped message is recognised regardless of header casing", () => {
    expect(wasLoggedAtSendTime({ internetMessageHeaders: [{ name: "x-boreal-logged", value: "1" }] })).toBe(true);
    expect(wasLoggedAtSendTime({ internetMessageHeaders: [{ name: SENT_LOGGED_HEADER, value: "1" }] })).toBe(true);
  });
  it("an unstamped message from another mail client is not skipped", () => {
    expect(wasLoggedAtSendTime(appleMail)).toBe(false);
  });
  it("writes nothing for a message the portal already logged", async () => {
    const calls: string[] = [];
    const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0 }; } } as any;
    const written = await logSentMessage(pool, "user-1", { ...appleMail, internetMessageHeaders: [{ name: SENT_LOGGED_HEADER, value: "1" }] });
    expect(written).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("only real, external contacts are logged", () => {
  it("drops internal colleagues", () => {
    expect(externalRecipients({
      toRecipients: [{ emailAddress: { address: "andrew.p@boreal.financial" } }],
      ccRecipients: [{ emailAddress: { address: "client@example.com" } }],
    })).toEqual(["client@example.com"]);
  });
  it("lower-cases and de-duplicates addresses", () => {
    expect(addressesOf([{ emailAddress: { address: "  Gifford@Example.com " } }])).toEqual(["gifford@example.com"]);
    expect(externalRecipients({
      toRecipients: [{ emailAddress: { address: "a@x.com" } }],
      ccRecipients: [{ emailAddress: { address: "A@X.com" } }],
    })).toEqual(["a@x.com"]);
  });
  it("does not invent a contact when the recipient is unknown", async () => {
    const statements: string[] = [];
    const pool = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM users")) return { rows: [{ silo: "BF" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } } as any;
    expect(await logSentMessage(pool, "user-1", appleMail)).toBe(0);
    expect(statements.some((s) => s.includes("INSERT INTO contacts"))).toBe(false);
    expect(statements.some((s) => s.includes("INSERT INTO crm_email_log"))).toBe(false);
  });
  it("writes one timeline row per matched contact, keyed to the Graph message", async () => {
    const inserts: any[][] = [];
    const pool = { query: async (sql: string, params: any[]) => {
      if (sql.includes("FROM users")) return { rows: [{ silo: "BF" }], rowCount: 1 };
      if (sql.includes("FROM contacts")) return { rows: [{ id: "contact-1" }], rowCount: 1 };
      inserts.push(params);
      return { rows: [], rowCount: 1 };
    } } as any;
    expect(await logSentMessage(pool, "user-1", appleMail)).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("AAMk-sent-1");
    expect(inserts[0]).toContain("contact-1");
  });
});
