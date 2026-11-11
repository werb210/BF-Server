-- BF_SERVER_v943_OFFER_TEMPLATE_MODE (Todd, Nov 11 2026): three ways to give the client a term sheet:
--   lender   - send the lender's own term sheet (lender named)
--   template - the lender's terms on our term sheet template, with our fees (lender named)
--   ours     - we buy the deal: our term sheet, our rate, no lender name
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_term_sheet_mode_check;
ALTER TABLE offers ADD CONSTRAINT offers_term_sheet_mode_check CHECK (term_sheet_mode IN ('lender', 'template', 'ours'));
