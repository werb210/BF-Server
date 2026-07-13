-- BF_SERVER_BOOKINGS_TO_CRM_v1
-- Microsoft Bookings appointments landed in the Outlook calendar and the portal rendered
-- them - and that was ALL that happened. Nothing parsed the booking, so a prospect who
-- booked a call and handed over their name, email, phone, address and what they wanted
-- ("WORKING CAPITAL LOANS") never became a CRM record. The lead simply evaporated.
--
-- This table is the idempotency ledger: one row per Graph event, so re-polling can never
-- create the same contact twice.
CREATE TABLE IF NOT EXISTS booking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_event_id text NOT NULL,
  silo text NOT NULL DEFAULT 'BF',
  organizer_upn text,
  subject text,
  service_name text,
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_address text,
  customer_notes text,
  scheduled_at timestamptz,
  scheduled_end_at timestamptz,
  contact_id uuid,
  task_id uuid,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The unique index IS the idempotency guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS booking_events_graph_event_uidx
  ON booking_events (graph_event_id);
CREATE INDEX IF NOT EXISTS booking_events_status_idx
  ON booking_events (status, scheduled_at);
CREATE INDEX IF NOT EXISTS booking_events_contact_idx
  ON booking_events (contact_id, silo);
