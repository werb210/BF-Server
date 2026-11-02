// BF_SERVER_v864_OOO_UNTIL - Boreal's out-of-office window against real Postgres: the migration twice, the presence
// recompute marks the user busy inside the window, inbound calls skip them, and it ends by itself at the end.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { recordBorealOutOfOffice, readBorealOutOfOffice } from "../modules/o365/outOfOffice.js";
import { recomputePresence, ringableStaffSql } from "../modules/presence/presenceService.js";

const user = randomUUID();
const tag = user.slice(0, 8);

async function ringable(): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM users u JOIN staff_presence sp ON sp.user_id = u.id WHERE u.id = $1 AND ${ringableStaffSql("sp", "u")}`, [user]);
  return r.rows.length > 0;
}

describe("v864 out of office until (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_01_v864_ooo_until.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    await pool.query("INSERT INTO users (id, email, active, role, first_name) VALUES ($1, $2, true, 'Staff', 'Pat')", [user, `${tag}-ooo@example.test`]);
    await pool.query("INSERT INTO staff_presence (user_id, twilio_identity, status, last_heartbeat) VALUES ($1, $2, 'available', now())", [user, user]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM team_user_status WHERE user_id = $1", [user]);
    await pool.query("DELETE FROM staff_presence WHERE user_id = $1", [user]);
    await pool.query("DELETE FROM users WHERE id = $1", [user]);
  });

  it("inside the window: busy, not rung, team status shows it; after the end it is over", async () => {
    const until = new Date(Date.now() + 3 * 86400000);
    await recordBorealOutOfOffice(user, { from: new Date(Date.now() - 60000), until }, "America/Edmonton");
    const state = await readBorealOutOfOffice(user);
    expect(state.active).toBe(true);
    expect(state.until).toBe(until.toISOString());
    const p = await pool.query("SELECT status FROM staff_presence WHERE user_id = $1", [user]);
    expect(p.rows[0].status).toBe("busy");
    expect(await ringable()).toBe(false);
    const t = await pool.query("SELECT status_text, status_until FROM team_user_status WHERE user_id = $1", [user]);
    expect(t.rows[0].status_text).toMatch(/^Out of office until /);
    expect(new Date(t.rows[0].status_until).toISOString()).toBe(until.toISOString());

    // The end passes: nothing has to switch it off.
    await pool.query("UPDATE staff_presence SET out_of_office_until = now() - interval '1 minute', last_heartbeat = now() WHERE user_id = $1", [user]);
    await recomputePresence(user);
    expect((await readBorealOutOfOffice(user)).active).toBe(false);
    const p2 = await pool.query("SELECT status FROM staff_presence WHERE user_id = $1", [user]);
    expect(["available", "busy"]).toContain(p2.rows[0].status); // busy only when outside 08:00-18:00 Alberta time
  });

  it("On with no end date stays on; Off clears it and the status it set", async () => {
    await recordBorealOutOfOffice(user, { from: new Date(Date.now() - 60000), until: null }, "America/Edmonton");
    const on = await readBorealOutOfOffice(user);
    expect(on.active).toBe(true);
    expect(on.until).toBeNull();
    expect(await ringable()).toBe(false);
    await recordBorealOutOfOffice(user, { from: null, until: null }, "America/Edmonton");
    expect((await readBorealOutOfOffice(user)).active).toBe(false);
    const t = await pool.query("SELECT status_text FROM team_user_status WHERE user_id = $1", [user]);
    expect(t.rows[0].status_text).toBeNull();
  });
});
