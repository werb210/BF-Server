-- BF_SERVER_LENDER_SBA_IVES_v753
-- Whether a lender offers SBA loans. When it does, the IVES fields added in v144 (participant name,
-- participant ID, SOR mailbox ID, address) are what IRS Form 4506-C names, so the applicant signs a
-- 4506-C for that lender in the same signing as the rest of the file. Null means not answered yet.
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS offers_sba BOOLEAN;
