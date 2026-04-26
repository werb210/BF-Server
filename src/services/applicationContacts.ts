import type { PoolClient } from "pg";

type ApplicationContactRole = "applicant" | "partner" | "guarantor" | "other";

export async function linkContactToApplication(
  client: Pick<PoolClient, "query">,
  applicationId: string,
  contactId: string,
  role: ApplicationContactRole
): Promise<void> {
  await client.query(
    `INSERT INTO application_contacts (application_id, contact_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [applicationId, contactId, role]
  );
}

export async function unlinkContactFromApplication(
  client: Pick<PoolClient, "query">,
  applicationId: string,
  contactId: string,
  role: ApplicationContactRole
): Promise<void> {
  await client.query(
    `DELETE FROM application_contacts
     WHERE application_id = $1 AND contact_id = $2 AND role = $3`,
    [applicationId, contactId, role]
  );
}
