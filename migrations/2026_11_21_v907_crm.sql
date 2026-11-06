-- BF_SERVER_v907_CRM - "Clean up data": a proposed change staff choose to ignore stays ignored (it is not proposed
-- again on the next scan unless the proposal itself changes).
CREATE TABLE IF NOT EXISTS crm_cleanup_ignores (
  silo text NOT NULL,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  field text NOT NULL,
  after_value text NOT NULL,
  before_value text,
  ignored_by uuid,
  ignored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (silo, entity, entity_id, field, after_value)
);
