// BF_SERVER_BLOCK_v610_BI_THREAD
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { biContactForPhone, biMarkReadForPhone, biSendForPhone, biThreadForPhone, biUnreadForPhone, cleanAttachments } from "../biApplicantThread.js";

function db(existing = true) {
  const msgs: any[] = [];
  const contacts: any[] = existing ? [{ id: "c-1", phone: "(780) 555-1212" }] : [];
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.includes("FROM contacts")) return { rows: contacts.filter((c) => c.phone.replace(/\D/g, "").slice(-10) === p[0]) };
    if (sql.startsWith("INSERT INTO contacts")) { contacts.push({ id: "c-new", phone: p[0] }); return { rows: [{ id: "c-new" }] }; }
    if (sql.includes("COUNT(*)::int AS n")) return { rows: [{ n: msgs.filter((m) => m.contact_id === p[0] && m.direction === "outbound" && !m.read_at).length }] };
    if (sql.startsWith("UPDATE communications_messages SET read_at")) { const hit = msgs.filter((m) => m.contact_id === p[0] && m.direction === "outbound" && !m.read_at); hit.forEach((m) => { m.read_at = "now"; }); return { rows: hit }; }
    if (sql.startsWith("INSERT INTO communications_messages")) { const m = { id: `m${msgs.length + 1}`, contact_id: p[0], body: p[1], direction: "inbound", attachments: JSON.parse(p[3]), created_at: "t" }; msgs.push(m); return { rows: [m] }; }
    if (sql.includes("FROM communications_messages")) return { rows: msgs.filter((m) => m.contact_id === p[0]).slice().reverse() };
    return { rows: [] };
  });
  return { query, msgs };
}

describe("BI applicant thread by phone", () => {
  it("finds or creates the BI contact from the phone", async () => {
    expect(await biContactForPhone(db().query as any, "+17805551212")).toBe("c-1");
    expect(await biContactForPhone(db(false).query as any, "+17805551212")).toBe("c-new");
    expect(await biContactForPhone(db().query as any, "12")).toBeNull();
  });

  it("sends, lists in the app's shape, counts and clears unread", async () => {
    const d = db();
    const sent = await biSendForPhone(d.query as any, "+17805551212", "Here is my contract", cleanAttachments([{ name: "c.pdf", contentType: "application/pdf", dataUrl: "data:application/pdf;base64,AA" }, { name: "x", dataUrl: "http://no" }]));
    expect(sent).toMatchObject({ body: "Here is my contract", sender: "applicant", attachments: [{ name: "c.pdf", url: "data:application/pdf;base64,AA" }] });
    d.msgs.push({ id: "m9", contact_id: "c-1", body: "Thanks!", direction: "outbound", staff_name: "Andrew", created_at: "t2" });
    const thread = await biThreadForPhone(d.query as any, "+17805551212");
    expect(thread?.messages.map((m) => [m.sender, m.body])).toEqual([["applicant", "Here is my contract"], ["staff", "Thanks!"]]);
    expect(thread?.unreadCount).toBe(1);
    expect(await biMarkReadForPhone(d.query as any, "+17805551212")).toBe(1);
    expect(await biUnreadForPhone(d.query as any, "+17805551212")).toBe(0);
  });

  it("wires the bridge, the BI notice phone, the BI-silo fallback skip and the passkey aliases", () => {
    const bridge = readFileSync("src/routes/serviceBridge.ts", "utf8");
    for (const r of ['router.get("/applicant-messages"', 'router.get("/applicant-messages/unread"', 'router.post("/applicant-messages/read"', 'router.post("/applicant-messages"']) expect(bridge).toContain(r);
    expect(bridge).not.toContain("contact_id_and_body_required");
    expect(readFileSync("src/services/biApplicantMessages.ts", "utf8")).toContain("        phone,\n");
    expect(readFileSync("src/routes/communications.ts", "utf8")).toContain('if (silo !== "BI")\n    // BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1');
    expect(readFileSync("src/routes/client/passkeys.ts", "utf8")).toContain('"/passkeys/authentication/verify": "/passkeys/login/verify"');
  });
});

describe("passkey path aliases", () => {
  it("registration/authentication names reach the real handlers", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const passkeys = (await import("../../routes/client/passkeys.js")).default;
    const app = express(); app.use(express.json()); app.use("/api/client", passkeys);
    expect((await request(app).post("/api/client/passkeys/registration/options")).status).toBe(401); // needs a client session, like register/options
    expect((await request(app).post("/api/client/passkeys/nope")).status).toBe(404);
  });
});
