-- BF_SERVER_BACKGROUND_UPLOAD_v306
-- Marks documents the phone finished uploading after the client closed the app,
-- so staff can tell a delayed upload from a late client.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS received_in_background boolean NOT NULL DEFAULT false;
