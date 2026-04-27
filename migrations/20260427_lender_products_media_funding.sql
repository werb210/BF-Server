-- BF_MEDIA_FUNDING_v38 — Block 38-F (server)
-- Add MEDIA_FUNDING to the category CHECK constraint. Idempotent.
ALTER TABLE IF EXISTS lender_products
  DROP CONSTRAINT IF EXISTS lender_products_category_check;

ALTER TABLE IF EXISTS lender_products
  ADD CONSTRAINT lender_products_category_check
  CHECK (
    category IN (
      'LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA',
      'LINE_OF_CREDIT','TERM_LOAN','INVOICE_FACTORING',
      'PURCHASE_ORDER_FINANCE','EQUIPMENT_FINANCE','STARTUP_CAPITAL',
      'MERCHANT_CASH_ADVANCE','ASSET_BASED_LENDING','SBA_GOVERNMENT',
      'MEDIA_FUNDING'
    )
  );
