-- BF_SERVER_VISITOR_JOURNEY_v1 - own the pre-application journey. Anonymous visitors are
-- keyed by session_id; when they submit an application the session is stitched to the
-- contact, so a CRM record can show: which ad brought them, every page, how long, where
-- they dropped off, and their path through the wizard.
CREATE TABLE IF NOT EXISTS visitor_sessions (
  session_id      text PRIMARY KEY,
  contact_id      text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  landing_page    text,
  referrer        text,
  gclid           text,
  gbraid          text,
  wbraid          text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_term        text,
  utm_content     text,
  user_agent      text,
  stitched_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_contact ON visitor_sessions (contact_id);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_gclid ON visitor_sessions (gclid);

CREATE TABLE IF NOT EXISTS visitor_events (
  id           bigserial PRIMARY KEY,
  session_id   text NOT NULL,
  event_type   text NOT NULL,
  path         text,
  title        text,
  step         text,
  dwell_ms     integer,
  meta         jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visitor_events_session ON visitor_events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_visitor_events_type ON visitor_events (event_type);
