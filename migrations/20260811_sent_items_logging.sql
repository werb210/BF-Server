-- BF_SERVER_SENT_ITEMS_v39
-- Two subscriptions per mailbox now (inbox and sent items), so the lookup key
-- becomes user + resource rather than user alone. Collapse any duplicates that
-- already exist before adding the constraint, or this migration crash-loops the
-- app on startup.
DELETE FROM graph_mail_subscriptions a
 USING graph_mail_subscriptions b
 WHERE a.user_id = b.user_id
   AND a.resource = b.resource
   AND a.expiration_datetime < b.expiration_datetime;

CREATE UNIQUE INDEX IF NOT EXISTS graph_mail_subs_user_resource_idx
  ON graph_mail_subscriptions (user_id, resource);

-- One Graph message can reach several CRM contacts, so it is the pair that must
-- be unique, not the message. This is what stops a replayed Graph notification
-- from writing the same email onto a timeline twice.
DELETE FROM crm_email_log a
 USING crm_email_log b
 WHERE a.graph_message_id IS NOT NULL
   AND a.graph_message_id = b.graph_message_id
   AND a.contact_id IS NOT DISTINCT FROM b.contact_id
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS crm_email_log_graph_msg_contact_idx
  ON crm_email_log (graph_message_id, contact_id)
  WHERE graph_message_id IS NOT NULL;
