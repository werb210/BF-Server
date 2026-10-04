-- BF_SERVER_CLIENT_BOOKING_v738 - calls and Teams meetings clients book themselves. The meeting
-- itself lives in the staff member's Outlook calendar; this row ties it to the CRM.
CREATE TABLE IF NOT EXISTS client_bookings (
  id              uuid PRIMARY KEY,
  contact_id      uuid,
  staff_user_id   uuid,
  staff_email     text NOT NULL,
  kind            text NOT NULL,
  starts_at       timestamptz NOT NULL,
  duration_min    integer NOT NULL DEFAULT 30,
  client_name     text NOT NULL,
  client_email    text,
  client_phone    text,
  notes           text,
  graph_event_id  text,
  join_url        text,
  status          text NOT NULL DEFAULT 'booked',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_bookings_starts_idx ON client_bookings (starts_at);
