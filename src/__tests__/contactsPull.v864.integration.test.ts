// BF_SERVER_v864_CONTACTS_PULL_FIX - the contact pull's SQL against real Postgres, with a fake Graph: a CRM contact is
// linked by its second Outlook address, gets the Outlook number, and Boreal's caller-ID query then finds it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { graphFor } = vi.hoisted(() => ({ graphFor: vi.fn() }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: graphFor }));

import { pool } from "../db.js";
import { pullOutlookContactsForUser } from "../modules/o365/contactPull.js";

const user = randomUUID();
const contact = randomUUID();
const tag = user.slice(0, 8);
const phone10 = "780" + String(Math.floor(1000000 + Math.random() * 8999999));

describe("v864 contacts pull (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users (id, email, active, role, first_name) VALUES ($1, $2, true, 'Staff', 'Pat')", [user, `${tag}-pull@example.test`]);
    await pool.query("INSERT INTO contacts (id, name, email, silo, owner_id) VALUES ($1, 'Walter Pull', $2, 'BF', $3)", [contact, `walter-${tag}@agrico.example`, user]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM contacts WHERE id = $1", [contact]);
    await pool.query("DELETE FROM users WHERE id = $1", [user]);
  });

  it("links, fills the phone, and caller ID resolves the inbound number", async () => {
    graphFor.mockResolvedValue({
      fetch: vi.fn(async () => new Response(JSON.stringify({ value: [{ id: "OUT-" + tag, emailAddresses: [{ address: "x@y.example" }, { address: `WALTER-${tag}@agrico.example` }], mobilePhone: phone10 }] }), { status: 200 })),
    });
    const r = await pullOutlookContactsForUser(pool as any, user);
    expect(r).toMatchObject({ connected: true, linked: 1, phonesAddedToCrm: 1 });
    const row = await pool.query("SELECT outlook_contact_id, phone FROM contacts WHERE id = $1", [contact]);
    expect(row.rows[0]).toEqual({ outlook_contact_id: "OUT-" + tag, phone: "+1" + phone10 });
    const caller = await pool.query(
      `SELECT c.id::text AS id FROM contacts c WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1 AND c.silo = $2`,
      [phone10, "BF"],
    );
    expect(caller.rows.map((x) => x.id)).toContain(contact);
    const again = await pullOutlookContactsForUser(pool as any, user);
    expect(again).toMatchObject({ linked: 0, phonesAddedToCrm: 0 });
  });
});
