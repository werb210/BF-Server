-- BF_SERVER_BLOCK_v616 - automation builder, phase 1: steps, enrollments, step log, starter automations.
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS reenroll text NOT NULL DEFAULT 'never';
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS template_key text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS rr_index integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS automation_rules_silo_trigger_idx ON automation_rules (silo, trigger_type) WHERE enabled;

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  rule_version integer NOT NULL DEFAULT 1,
  silo text NOT NULL,
  contact_id uuid,
  application_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
  current_step integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  test_mode boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS automation_enrollments_due_idx ON automation_enrollments (next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS automation_enrollments_rule_contact_idx ON automation_enrollments (rule_id, contact_id);
CREATE INDEX IF NOT EXISTS automation_enrollments_rule_app_idx ON automation_enrollments (rule_id, application_id);

CREATE TABLE IF NOT EXISTS automation_step_log (
  id bigserial PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL,
  step_index integer NOT NULL,
  step_type text NOT NULL,
  outcome text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_step_log_enrollment_idx ON automation_step_log (enrollment_id, id);

-- Starter automations for Boreal Financial, switched OFF until staff review and turn them on.
INSERT INTO automation_rules (silo, name, description, trigger_type, conditions, actions, steps, enabled, reenroll, template_key)
SELECT 'BF', v.name, v.description, v.trigger_type, v.conditions::jsonb, '[]'::jsonb, v.steps::jsonb, false, v.reenroll, v.template_key
  FROM (VALUES
  ('starter_doc_rejected', 'Rejected document not re-uploaded',
   'A document is rejected. The client already gets the rejection text and app notice; if it is still not replaced after 2 days, remind them and give the deal owner a follow-up task.',
   'document.rejected', '[]',
   '[{"type":"wait","amount":2,"unit":"days"},{"type":"check","check":"documents_still_rejected"},{"type":"notify_client","title":"Document still needed","body":"Hi {{first_name}}, we still need a new {{document_type}} to keep your application moving. Tap to upload it."},{"type":"create_task","title":"Follow up: {{document_type}} not re-uploaded","taskType":"CALL","priority":"HIGH","dueHours":4,"assignTo":"owner"}]',
   'always'),
  ('starter_new_lead', 'New website lead',
   'Someone fills in the website contact form or the readiness check: assign an owner in turn, send an intro text (with consent) and create a call task due within the hour.',
   'contact.created', '[{"field":"source","op":"in","value":["website","readiness_check"]}]',
   '[{"type":"assign_owner","mode":"round_robin","userIds":[]},{"type":"send_sms","purpose":"marketing","body":"Hi {{first_name}}, thanks for reaching out to Boreal Financial. {{owner_name}} will call you shortly."},{"type":"create_task","title":"Call new lead {{full_name}}","taskType":"CALL","priority":"HIGH","dueHours":1,"assignTo":"owner"}]',
   'never'),
  ('starter_offer_unsigned', 'Offer not accepted after 48 hours',
   'The application moves to Offer. If it is still at Offer 48 hours later, remind the client and give the owner a task.',
   'application.stage_changed', '[{"field":"to_stage","op":"eq","value":"Offer"}]',
   '[{"type":"wait","amount":48,"unit":"hours"},{"type":"check","check":"still_in_stage"},{"type":"notify_client","title":"Your offer is waiting","body":"Hi {{first_name}}, your offer is ready to review and sign in the Boreal app."},{"type":"create_task","title":"Offer not signed after 48 hours","taskType":"CALL","priority":"HIGH","dueHours":4,"assignTo":"owner"}]',
   'always'),
  ('starter_funded', 'Funded: thank you, referral ask, insurance',
   'The application moves to Accepted: thank the client, flag an Insurance (PGI) conversation, and 7 days later ask for a referral (with consent).',
   'application.stage_changed', '[{"field":"to_stage","op":"eq","value":"Accepted"}]',
   '[{"type":"notify_client","title":"Congratulations","body":"Congratulations {{first_name}} - your financing is complete. Thank you for choosing Boreal."},{"type":"create_task","title":"Discuss personal guarantee insurance (PGI) with {{full_name}}","taskType":"CALL","priority":"MEDIUM","dueHours":48,"assignTo":"owner"},{"type":"wait","amount":7,"unit":"days"},{"type":"send_sms","purpose":"marketing","body":"Hi {{first_name}}, glad we could help. If you know a business owner who needs financing, reply with their name - we look after referrals."}]',
   'never'),
  ('starter_missed_call', 'Missed inbound call',
   'A client call is missed: create a callback task and text them that we will call back shortly.',
   'call.missed', '[]',
   '[{"type":"create_task","title":"Call back {{full_name}}","taskType":"CALL","priority":"HIGH","dueHours":0,"assignTo":"owner"},{"type":"send_sms","purpose":"transactional","body":"Sorry we missed your call - we will call you back shortly. - Boreal Financial"}]',
   'always')
  ) AS v(template_key, name, description, trigger_type, conditions, steps, reenroll)
 WHERE NOT EXISTS (SELECT 1 FROM automation_rules r WHERE r.silo = 'BF' AND r.template_key = v.template_key);
