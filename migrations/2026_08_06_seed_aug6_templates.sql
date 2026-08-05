-- BF_SERVER_SEED_AUG6_TEMPLATES_v21
-- Seeds the two BF campaign templates into the library so they are picked from
-- "Load template" and cannot be lost. link_url and html stay NULL on purpose:
-- a landing page can only be minted by the API on save (createLandingPageFromHtml),
-- not from SQL. Open each template, add the image, then Save to library under
-- the same name - v18 updates in place and the landing URL appears in the box.
-- Guarded by name so re-running never duplicates and never overwrites edits.

INSERT INTO marketing_template (silo, channel, name, subject, fields)
SELECT 'BF', 'email', 'Aug 6th - Clients (past applicants)', 'New lenders on the Boreal panel since you applied', '{"headline": "{{first_name}}, your file may fit lenders that weren''t there before", "heroUrl": "", "heroLink": "https://client.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-clients&utm_content=left", "body": "Our lender panel has grown since you last applied, and credit boxes change month to month. A no six months ago is not a no today. Your details are still on file - a second look takes about ten minutes.", "ctaLabel": "See where you stand", "ctaUrl": "https://client.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-clients&utm_content=left", "headline2": "We now fund in the United States", "body2": "If you were ever told your deal was Canada-only - a US subsidiary, US-domiciled equipment, cross-border receivables - that constraint is gone. Same team, same process, both sides of the border.", "rightImageUrl": "", "rightImageLink": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-clients&utm_content=right", "cta2Label": "Talk to us about a US deal", "cta2Url": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-clients&utm_content=right"}'::jsonb
 WHERE NOT EXISTS (
   SELECT 1 FROM marketing_template
    WHERE silo = 'BF' AND channel = 'email' AND name = 'Aug 6th - Clients (past applicants)'
 );

INSERT INTO marketing_template (silo, channel, name, subject, fields)
SELECT 'BF', 'email', 'Aug 6th - Referrers & advisors', 'What a referred client is worth to your practice', '{"headline": "Your clients are already looking for capital", "heroUrl": "", "heroLink": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-referrers&utm_content=left", "body": "They ask you before they ask a bank. Right now you have nowhere to send them, so the conversation ends with a shrug. We take the file, run it across the panel, and report back to you - not around you.", "ctaLabel": "How it works", "ctaUrl": "https://www.boreal.financial/?utm_source=email&utm_medium=marketing&utm_campaign=aug6-referrers&utm_content=left", "headline2": "You get paid, and you keep the client", "body2": "Commission on funded deals, paid to you. We never cross-sell your client anything else and we never go around you. Sign up takes a few minutes and you can track every referral you send.", "rightImageUrl": "", "rightImageLink": "https://www.boreal.financial/referrer?utm_source=email&utm_medium=marketing&utm_campaign=aug6-referrers&utm_content=right", "cta2Label": "Become a referral partner", "cta2Url": "https://www.boreal.financial/referrer?utm_source=email&utm_medium=marketing&utm_campaign=aug6-referrers&utm_content=right"}'::jsonb
 WHERE NOT EXISTS (
   SELECT 1 FROM marketing_template
    WHERE silo = 'BF' AND channel = 'email' AND name = 'Aug 6th - Referrers & advisors'
 );
