-- BF_SERVER_v918_REMOVE_SEEDED_TEMPLATES - Todd (Nov 9): remove the email templates Claude loaded (the 72 year-end
-- write-off templates and the app-launch templates). Only rows created by the seeders are removed; templates staff
-- made are untouched. The seeders no longer run on startup, so they do not come back. Safe to run again.
DELETE FROM marketing_template
 WHERE created_by IN ('ye26-seed', 'app-launch-seed', 'applaunch-seed')
    OR name LIKE 'YE26 Write-Off ·%';
