-- BF_SERVER_SIGNED_TERM_SHEET_v7
-- Links a returned, signed term sheet back to the offer it belongs to. Without
-- this the document lands on the application with no way to tell which offer it
-- signs, which matters as soon as two lenders both send one.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS offer_id uuid;
CREATE INDEX IF NOT EXISTS documents_offer_id_idx ON documents(offer_id);
