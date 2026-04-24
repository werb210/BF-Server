alter table if exists crm_leads add column if not exists requested_amount text;
alter table if exists crm_leads add column if not exists credit_score_range text;
alter table if exists crm_leads add column if not exists product_interest text;
alter table if exists crm_leads add column if not exists industry_interest text;
