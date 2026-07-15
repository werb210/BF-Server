-- BF_SERVER_BLOCK_v_LENDER_BROKER_AGREEMENT_v1
-- Flag for lenders Boreal holds a signed broker agreement with. Surfaced as a
-- checkmark column on the staff Lenders list and a checkbox on the lender form.
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS has_broker_agreement BOOLEAN NOT NULL DEFAULT false;
