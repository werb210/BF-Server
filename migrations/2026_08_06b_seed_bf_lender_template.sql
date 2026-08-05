-- BF_SERVER_SEED_BF_LENDER_TEMPLATE_v23
-- 2026_08_06_seed_aug6_templates.sql was applied while it contained two
-- templates. It was later edited in place to add a third, but the runner records
-- applied migrations by FILENAME, so the edit was never executed and
-- "Aug 6th - Lenders" never reached the library. A migration that has run is
-- immutable in practice; the only correct fix is a new file.
INSERT INTO marketing_template (silo, channel, name, subject, fields)
SELECT 'BF', 'email', 'Aug 6th - Lenders', 'Your Boreal lender portal is ready',
'{"headline": "Your deal flow in one place", "heroUrl": "", "heroLink": "https://staff.boreal.financial/lender-portal/login?utm_source=email&utm_medium=marketing&utm_campaign=aug6-bf-lenders&utm_content=left", "body": "Submissions, documents, decisions and status in one view instead of scattered across email threads. You see the full file the moment we send it, and we see your decision the moment you make it.", "ctaLabel": "Open the portal", "ctaUrl": "https://staff.boreal.financial/lender-portal/login?utm_source=email&utm_medium=marketing&utm_campaign=aug6-bf-lenders&utm_content=left", "headline2": "{{first_name}}, set up your sign-in", "body2": "Sign in with your phone number - no password to store or reset. If you would rather have someone walk you through it first, say the word and we will book fifteen minutes.", "rightImageUrl": "", "rightImageLink": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-bf-lenders&utm_content=right", "cta2Label": "Book a walkthrough", "cta2Url": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-bf-lenders&utm_content=right"}'::jsonb
 WHERE NOT EXISTS (
   SELECT 1 FROM marketing_template
    WHERE silo = 'BF' AND channel = 'email' AND name = 'Aug 6th - Lenders'
 );
