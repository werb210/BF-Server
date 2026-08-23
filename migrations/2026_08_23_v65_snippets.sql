-- BF_SERVER_SNIPPETS_v65
-- message_templates already backs the email/message/SMS template picker. Two
-- gaps stop it serving as the snippet store Todd asked for:
--   1. no 'team' channel, so Team chat cannot use it
--   2. no way to tell a short reusable snippet from a full template
--
-- The channel CHECK is rebuilt rather than dropped, so an existing row with an
-- invalid channel would fail loudly here rather than silently later.
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_channel_check;
ALTER TABLE message_templates
  ADD CONSTRAINT message_templates_channel_check
  CHECK (channel IN ('email','message','sms','team'));

-- A snippet is a short insertable fragment; a template is a whole message.
-- Same table because they share every other column and the same permissions.
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS is_snippet boolean NOT NULL DEFAULT false,
  -- Typing "#pnw" beats scrolling a list. Unique per silo per owner so two
  -- people can each have their own #pnw.
  ADD COLUMN IF NOT EXISTS shortcut text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_shortcut
  ON message_templates (silo, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(shortcut))
  WHERE shortcut IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_templates_snippets
  ON message_templates (silo, channel, is_snippet);
