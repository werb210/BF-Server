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

function getClient(client?: PoolClient): PoolClient | typeof pool {
  return client ?? pool;
}

export async function upsertStructuredApplicationData(
  input: StructuredInput,
  client?: PoolClient
): Promise<void> {
  const db = getClient(client);
  const borrowerUpsert = await db.query<{ id: string }>(
    `insert into borrowers
      (id, application_id, company_name, operating_name, entity_type, incorporation_date, country, province_state, industry, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
     on conflict (application_id)
     do update
       set company_name = excluded.company_name,
           operating_name = excluded.operating_name,
           entity_type = excluded.entity_type,
           incorporation_date = excluded.incorporation_date,
           country = excluded.country,
           province_state = excluded.province_state,
           industry = excluded.industry,
           updated_at = now()
     returning id`,
    [
      randomUUID(),
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
  const borrowerId = borrowerUpsert.rows[0]?.id;
  if (!borrowerId) {
    return;
  }

  await db.query(
    `insert into financials (id, borrower_id, annual_revenue, time_in_business_months, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (borrower_id)
     do update
       set annual_revenue = excluded.annual_revenue,
           time_in_business_months = excluded.time_in_business_months,
           updated_at = now()`,
    [randomUUID(), borrowerId, input.annualRevenue ?? null, input.timeInBusinessMonths ?? null]
  );

  await db.query(
    `insert into collateral
      (id, borrower_id, accounts_receivable_value, inventory_value, equipment_value, real_estate_value, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now(), now())
     on conflict (borrower_id)
     do update
       set accounts_receivable_value = excluded.accounts_receivable_value,
           inventory_value = excluded.inventory_value,
           equipment_value = excluded.equipment_value,
           real_estate_value = excluded.real_estate_value,
           updated_at = now()`,
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
