alter table users
  add column if not exists o365_user_email       text null,
  add column if not exists o365_access_token     text null,
  add column if not exists o365_refresh_token    text null,
  add column if not exists o365_token_expires_at timestamptz null;
