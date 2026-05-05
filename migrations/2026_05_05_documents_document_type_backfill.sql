-- BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1
UPDATE documents
   SET document_type = category
 WHERE category IS NOT NULL
   AND category <> ''
   AND (document_type IS NULL OR document_type = 'general')
   AND category <> 'general';
