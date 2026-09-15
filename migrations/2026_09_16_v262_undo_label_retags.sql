-- BF_SERVER_MISFILED_DOCS_v262
-- The OCR auto-retag compared a document's category label ("6 months business
-- banking statements") with the classifier's key ("bank_statements_6_months"),
-- decided they differed, and rewrote correctly filed documents to the key. The
-- outstanding-documents check matches categories by exact text, so a retagged
-- statement stopped satisfying its requirement. Undo only retags where the old
-- label means the same document; genuine moves (a tax return filed under
-- financials) are kept. Safe to re-run.
UPDATE documents
   SET category = category_before_retag,
       category_before_retag = NULL
 WHERE category_before_retag IS NOT NULL
   AND category IS DISTINCT FROM category_before_retag
   AND (
        (category = 'bank_statements_6_months' AND category_before_retag ~* 'bank' AND category_before_retag ~* 'statement')
     OR (category = 'tax_returns' AND category_before_retag ~* '(tax.?return|notice of assessment)')
     OR (category = 'financial_statements' AND category_before_retag ~* '(financial|balance.?sheet|p&l|pnl|profit|income statement)')
     OR (category = 'void_cheque' AND category_before_retag ~* '(void|cheque|check)')
     OR (category = 'government_id' AND category_before_retag ~* '(licen|government.?id|photo.?id|passport|driver|id_document)')
     OR (category = 'articles_of_incorporation' AND category_before_retag ~* 'articles')
   );
