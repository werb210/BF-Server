-- BF_SERVER_CONTACT_ONEDRIVE_v1 - per-contact OneDrive folder link (BF CRM).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS onedrive_folder_id  text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS onedrive_drive_id   text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS onedrive_folder_url text;
