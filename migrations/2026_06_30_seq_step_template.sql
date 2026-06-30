-- BF_SERVER_BLOCK_v788_SEQ_TEMPLATES — a step points at a saved marketing_template.
ALTER TABLE IF EXISTS marketing_sequence_steps ADD COLUMN IF NOT EXISTS template_id uuid;
