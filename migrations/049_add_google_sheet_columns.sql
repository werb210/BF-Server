alter table lenders
  add column if not exists google_sheet_id text null,
  add column if not exists google_sheet_tab text null,
  add column if not exists google_sheet_mapping jsonb null;
