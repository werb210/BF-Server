// BF_SERVER_BOOKINGS_TO_CRM_v1
// Microsoft Bookings appointments landed in the Outlook calendar, the portal rendered
// them, and NOTHING else happened. A prospect who booked a call and handed over their
// name, email, phone, address and what they wanted ("WORKING CAPITAL LOANS") never became
// a CRM record - the lead evaporated. Nothing in the calendar path touched the CRM.
//
// This polls the staff calendar for Bookings appointments, parses the Customer Info block
// out of the event body, creates or links a contact, and puts a task in the queue.
// Idempotent on the Graph event id, so re-polling can never duplicate a lead.
import type { Pool } from "pg";
import { graphAppFetch, isAppGraphConfigured } from "../services/teams/graphAppClient.js";
import { parseBooking, isBookingBody, toE164 } from "../services/bookings/parseBooking.js";

const POLL_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 30;
const LOOKAHEAD_DAYS = 60;

type GraphEvent = {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  body?: { content?: string };
  organizer?: { emailAddress?: { address?: string } };
};

async function staffUpns(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT DISTINCT lower(email) AS email
       FROM users
      WHERE email IS NOT NULL AND email <> ''
        AND role IN ('Admin','Staff','Ops','Marketing')`,
  );
  return rows.map((r) => r.email).filter(Boolean);
}

async function fetchBookings(upn: string): Promise<GraphEvent[]> {
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const to = new Date(Date.now() + LOOKAHEAD_DAYS * 86400000).toISOString();
  const path =
    `/users/${encodeURIComponent(upn)}/calendarView` +
    `?startDateTime=${from}&endDateTime=${to}` +
    `&$select=id,subject,start,end,body,organizer&$top=200`;

  const resp = await graphAppFetch(path);
  if (!resp.ok) {
    console.error("[bookings] calendarView failed", { upn, status: resp.status });
    return [];
  }
  const json = (await resp.json()) as { value?: GraphEvent[] };
  return (json.value ?? []).filter((e) => isBookingBody(e.body?.content));
}

async function ingest(pool: Pool, upn: string, ev: GraphEvent): Promise<void> {
  const parsed = parseBooking(ev.body?.content);
  if (!parsed) return;

  const phone = toE164(parsed.customerPhone);
  const email = parsed.customerEmail.trim().toLowerCase();

  const claim = await pool.query<{ id: string }>(
    `INSERT INTO booking_events
       (graph_event_id, silo, organizer_upn, subject, service_name,
        customer_name, customer_email, customer_phone, customer_address, customer_notes,
        scheduled_at, scheduled_end_at, status)
     VALUES ($1, 'BF', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
     ON CONFLICT (graph_event_id) DO NOTHING
     RETURNING id`,
    [
      ev.id, upn, ev.subject ?? null, parsed.serviceName || null,
      parsed.customerName || null, email || null, phone || null,
      parsed.customerAddress || null, parsed.customerNotes || null,
      ev.start?.dateTime ?? null, ev.end?.dateTime ?? null,
    ],
  );
  if (claim.rowCount === 0) return;

  const bookingId = claim.rows[0]!.id;

  try {
    const found = await pool.query<{ id: string }>(
      `SELECT id FROM contacts
        WHERE silo = 'BF'
          AND (
            ($1 <> '' AND lower(email) = $1)
            OR ($2 <> '' AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10)
                           = right(regexp_replace($2, '[^0-9]', '', 'g'), 10))
          )
        ORDER BY created_at ASC
        LIMIT 1`,
      [email, phone],
    );

    let contactId = found.rows[0]?.id ?? null;

    if (!contactId) {
      const parts = parsed.customerName.trim().split(/\s+/);
      const firstName = parts[0] ?? "";
      const lastName = parts.slice(1).join(" ");
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (id, name, first_name, last_name, email, phone, address_street, status, silo, tags, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''),
                 'lead', 'BF', ARRAY['booking']::text[], now(), now())
         RETURNING id`,
        [parsed.customerName || email || phone, firstName, lastName, email, phone, parsed.customerAddress],
      );
      contactId = ins.rows[0]!.id;
    } else {
      await pool.query(
        `UPDATE contacts
            SET tags = coalesce(tags,'{}') || ARRAY['booking']::text[], updated_at = now()
          WHERE id = $1 AND NOT ('booking' = ANY(coalesce(tags,'{}')))`,
        [contactId],
      );
    }

    const owner = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [upn],
    );
    const ownerId = owner.rows[0]?.id ?? null;

    let taskId: string | null = null;
    if (ownerId) {
      const t = await pool.query<{ id: string }>(
        `INSERT INTO tasks
           (silo, title, body, type, priority, due_at, assignee_user_id,
            contact_id, created_by, source, source_ref_id)
         VALUES ('BF', $1, $2, 'CALL', 'HIGH', $3, $4::uuid, $5::uuid, $4::uuid, 'WORKFLOW', $6::uuid)
         RETURNING id`,
        [
          `Booked call: ${parsed.customerName || "prospect"}`,
          [parsed.serviceName, parsed.customerNotes].filter(Boolean).join(" - ") || null,
          ev.start?.dateTime ?? null,
          ownerId,
          contactId,
          bookingId,
        ],
      );
      taskId = t.rows[0]?.id ?? null;
    }

    await pool.query(
      `UPDATE booking_events
          SET contact_id = $2::uuid, task_id = $3::uuid, status = 'ingested', updated_at = now()
        WHERE id = $1`,
      [bookingId, contactId, taskId],
    );
    console.log("[bookings] ingested", {
      graph_event_id: ev.id, contact_id: contactId, task_id: taskId, name: parsed.customerName,
    });
  } catch (err) {
    const message = (err as { message?: string })?.message ?? String(err);
    await pool.query(
      `UPDATE booking_events SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [bookingId, message.slice(0, 500)],
    ).catch(() => undefined);
    console.error("[bookings] ingest failed", { graph_event_id: ev.id, message });
  }
}

export function startBookingsWorker(pool: Pool): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    if (!isAppGraphConfigured()) return;
    running = true;
    try {
      const upns = await staffUpns(pool);
      for (const upn of upns) {
        const events = await fetchBookings(upn);
        for (const ev of events) {
          await ingest(pool, upn, ev);
        }
      }
    } catch (err) {
      console.error("[bookings] tick failed:", (err as { message?: string })?.message ?? err);
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), POLL_MS);
  return { stop: () => clearInterval(handle) };
}
