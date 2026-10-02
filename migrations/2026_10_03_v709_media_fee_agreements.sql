-- BF_SERVER_MEDIA_FEE_AGREEMENT_v709
-- One client Services Agreement (2% fee on funding) per MEDIA application sent
-- to a lender that does not pay Boreal (lenders.has_broker_agreement = false).
CREATE TABLE IF NOT EXISTS media_fee_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  trigger_lender_id text,
  trigger_lender_name text,
  signer_name text,
  signer_email text,
  signer_phone text,
  signer_title text,
  signer_is_applicant boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending',
  signnow_group_id text,
  signnow_doc_id text,
  signnow_invite_id text,
  document_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  signed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS media_fee_agreements_application_uidx ON media_fee_agreements (application_id);
CREATE INDEX IF NOT EXISTS media_fee_agreements_group_idx ON media_fee_agreements (signnow_group_id);
CREATE INDEX IF NOT EXISTS media_fee_agreements_doc_idx ON media_fee_agreements (signnow_doc_id);
