-- 134_lender_products_category_expand.sql
-- Expand lender_products category check constraint to support
-- both legacy short codes and portal long-form categories.

ALTER TABLE IF EXISTS lender_products
  DROP CONSTRAINT IF EXISTS lender_products_category_check;

ALTER TABLE IF EXISTS lender_products
  ADD CONSTRAINT lender_products_category_check
  CHECK (
    category IN (
      'LOC',
      'TERM',
      'FACTORING',
      'PO',
      'EQUIPMENT',
      'MCA',
      'LINE_OF_CREDIT',
      'TERM_LOAN',
      'INVOICE_FACTORING',
      'PURCHASE_ORDER_FINANCE',
      'EQUIPMENT_FINANCE',
      'STARTUP_CAPITAL'
    )
  );
