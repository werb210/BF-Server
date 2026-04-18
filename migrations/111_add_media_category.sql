-- 111_add_media_category.sql
-- Adds MEDIA as a valid lender product category.

-- Drop old constraint (from 041/110 whichever applied)
ALTER TABLE IF EXISTS lender_products
  DROP CONSTRAINT IF EXISTS lender_products_category_check;

-- Back-fill any rows that used a media-like value
UPDATE lender_products
SET category = 'MEDIA'
WHERE UPPER(COALESCE(category, '')) IN ('MEDIA','MEDIA_FINANCING','FILM','FILM_FINANCING');

-- Recreate constraint with MEDIA included
ALTER TABLE IF EXISTS lender_products
  ADD CONSTRAINT lender_products_category_check
  CHECK (category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA'));
