import { randomUUID } from "crypto";
import { pool } from "../db";
import type { PoolClient } from "pg";

type StructuredInput = {
  applicationId: string;
  companyName: string;
  operatingName?: string | null;
  entityType?: string | null;
  incorporationDate?: string | null;
  country?: string | null;
  provinceState?: string | null;
  industry?: string | null;
  annualRevenue?: number | null;
  timeInBusinessMonths?: number | null;
  collateral?: {
    accountsReceivableValue?: number | null;
    inventoryValue?: number | null;
    equipmentValue?: number | null;
    realEstateValue?: number | null;
  };
  owners?: Array<{
    name: string;
    ownershipPercentage?: number | null;
    email?: string | null;
    phone?: string | null;
  }>;
};

function fetchClient(client?: PoolClient): PoolClient | typeof pool {
  return client ?? pool;
}

export async function upsertStructuredApplicationData(
  input: StructuredInput,
  client?: PoolClient
): Promise<void> {
  const db = fetchClient(client);
  const existingBorrower = await db.query<{ id: string }>(
    `select id from borrowers where application_id = $1 limit 1`,
    [input.applicationId]
  );
  const borrowerId = existingBorrower.rows[0]?.id ?? randomUUID();

  if (existingBorrower.rows[0]?.id) {
    await db.query(
      `update borrowers
         set company_name = $2,
             operating_name = $3,
             entity_type = $4,
             incorporation_date = $5,
             country = $6,
             province_state = $7,
             industry = $8,
             updated_at = now()
       where application_id = $1`,
      [
        input.applicationId,
        input.companyName,
        input.operatingName ?? null,
        input.entityType ?? null,
        input.incorporationDate ?? null,
        input.country ?? null,
        input.provinceState ?? null,
        input.industry ?? null,
      ]
    );
  } else {
    await db.query(
      `insert into borrowers
        (id, application_id, company_name, operating_name, entity_type, incorporation_date, country, province_state, industry, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
      [
        borrowerId,
        input.applicationId,
        input.companyName,
        input.operatingName ?? null,
        input.entityType ?? null,
        input.incorporationDate ?? null,
        input.country ?? null,
        input.provinceState ?? null,
        input.industry ?? null,
      ]
    );
  }

  if (!borrowerId) {
    return;
  }

  await db.query(`delete from financials where borrower_id = $1`, [borrowerId]);
  await db.query(
    `insert into financials (id, borrower_id, annual_revenue, time_in_business_months, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())`,
    [randomUUID(), borrowerId, input.annualRevenue ?? null, input.timeInBusinessMonths ?? null]
  );

  await db.query(`delete from collateral where borrower_id = $1`, [borrowerId]);
  await db.query(
    `insert into collateral
      (id, borrower_id, accounts_receivable_value, inventory_value, equipment_value, real_estate_value, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now(), now())`,
    [
      randomUUID(),
      borrowerId,
      input.collateral?.accountsReceivableValue ?? null,
      input.collateral?.inventoryValue ?? null,
      input.collateral?.equipmentValue ?? null,
      input.collateral?.realEstateValue ?? null,
    ]
  );

  if (input.owners && input.owners.length > 0) {
    await db.query(`delete from owners where borrower_id = $1`, [borrowerId]);
    for (const owner of input.owners) {
      await db.query(
        `insert into owners
          (id, borrower_id, name, ownership_percentage, email, phone, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, now(), now())`,
        [
          randomUUID(),
          borrowerId,
          owner.name,
          owner.ownershipPercentage ?? null,
          owner.email ?? null,
          owner.phone ?? null,
        ]
      );
    }
  }
}
