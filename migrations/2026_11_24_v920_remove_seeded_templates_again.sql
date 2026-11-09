-- BF_SERVER_v920_REMOVE_SEEDED_TEMPLATES_AGAIN - v918 removed the seeded year-end and app-launch templates, but during
-- the slot swap the previous build (which still seeded them on start) restarted against the same database and put
-- them back. No build seeds them any more, so this second pass is final. Staff-made templates are untouched.
DELETE FROM marketing_template
 WHERE created_by IN ('ye26-seed', 'app-launch-seed', 'applaunch-seed')
    OR name LIKE 'YE26 Write-Off ·%'
    OR name LIKE 'App Launch ·%';
