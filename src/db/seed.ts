import { pool, runQuery } from "../db";
import { ROLES } from "../auth/roles";
import { runMigrations } from "../migrations";
import { logInfo } from "../observability/logger";

export const SEEDED_ADMIN_PHONE = "+15878881837";
export const SEEDED_ADMIN_ID = "00000000-0000-0000-0000-000000000099";
export const SEEDED_ADMIN_EMAIL = "seeded-admin@boreal.financial";
export const SEEDED_ADMIN2_PHONE = "+1-780-264-8467";
export const SEEDED_ADMIN2_ID = "00000000-0000-0000-0000-000000000100";
export const SEEDED_ADMIN2_EMAIL = "seeded-admin-2@boreal.financial";
export const SEEDED_LENDER_ID = "00000000-0000-0000-0000-000000000200";
export const SEEDED_LENDER_PRODUCT_TERM_ID = "00000000-0000-0000-0000-000000000201";
export const SEEDED_LENDER_PRODUCT_LOC_ID = "00000000-0000-0000-0000-000000000202";

export async function seedAdminUser(): Promise<{ id: string; phoneNumber: string }> {
  const phoneNumber = SEEDED_ADMIN_PHONE;
  await runQuery(
    `insert into users (
        id,
        email,
        phone_number,
        phone,
        role,
        active,
        is_active,
        disabled,
        locked_until,
        phone_verified
      )
     values ($1, $2, $3, $4, $5, true, true, false, null, true)
     on conflict (phone_number) do update
       set email = excluded.email,
           phone = excluded.phone,
           role = excluded.role,
           active = excluded.active,
           is_active = excluded.is_active,
           disabled = excluded.disabled,
           locked_until = excluded.locked_until,
           phone_verified = excluded.phone_verified`,
    [SEEDED_ADMIN_ID, SEEDED_ADMIN_EMAIL, phoneNumber, phoneNumber, ROLES.ADMIN]
  );
  return { id: SEEDED_ADMIN_ID, phoneNumber };
}

export async function seedSecondAdminUser(): Promise<{
  id: string;
  phoneNumber: string;
}> {
  const phoneNumber = SEEDED_ADMIN2_PHONE;
  await runQuery(
    `insert into users (
        id,
        email,
        phone_number,
        phone,
        role,
        active,
        is_active,
        disabled,
        locked_until,
        phone_verified
      )
     values ($1, $2, $3, $4, $5, true, true, false, null, true)
     on conflict (phone_number) do update
       set email = excluded.email,
           phone = excluded.phone,
           role = excluded.role,
           active = excluded.active,
           is_active = excluded.is_active,
           disabled = excluded.disabled,
           locked_until = excluded.locked_until,
           phone_verified = excluded.phone_verified`,
    [SEEDED_ADMIN2_ID, SEEDED_ADMIN2_EMAIL, phoneNumber, phoneNumber, ROLES.ADMIN]
  );
  return { id: SEEDED_ADMIN2_ID, phoneNumber };
}

export async function seedBaselineLenders(): Promise<void> {
  const { rows: tableRows } = await runQuery<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('lenders', 'lender_products')`
  );
  const tableSet = new Set(tableRows.map((row: any) => row.table_name));
  if (!tableSet.has("lenders") || !tableSet.has("lender_products")) {
    logInfo("baseline_lenders_seed_skipped", {
      reason: "tables_missing",
      lendersTableExists: tableSet.has("lenders"),
      lenderProductsTableExists: tableSet.has("lender_products"),
    });
    return;
  }

  const { rows } = await runQuery<{ count: number }>(
    "select count(*)::int as count from lenders"
  );
  if ((rows[0]?.count ?? 0) > 0) {
    return;
  }

  await runQuery(
    `insert into lenders
     (id, name, active, status, submission_method, website, country, created_at, updated_at)
     values ($1, $2, true, 'ACTIVE', 'email', $3, $4, now(), now())`,
    [
      SEEDED_LENDER_ID,
      "Atlas Capital",
      "https://atlascapital.example.com",
      "US",
    ]
  );

  await runQuery(
    `insert into lender_products
     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values
     ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MONTHS', true, $11, now(), now()),
     ($12, $2, $13, $14, $15, $16, $17, $18, $19, $20, 'MONTHS', true, $21, now(), now())`,
    [
      SEEDED_LENDER_PRODUCT_TERM_ID,
      SEEDED_LENDER_ID,
      "Term Loan",
      "TERM",
      "US",
      "FIXED",
      "8.0",
      "12.0",
      12,
      60,
      JSON.stringify([{ type: "bank_statement", months: 6 }]),
      SEEDED_LENDER_PRODUCT_LOC_ID,
      "Line of Credit",
      "LOC",
      "US",
      "VARIABLE",
      "P+",
      "P+",
      6,
      24,
      JSON.stringify([{ type: "bank_statement", months: 6 }]),
    ]
  );
}

export async function seedDatabase(): Promise<void> {
  await runMigrations();
  await seedAdminUser();
  await seedSecondAdminUser();
  await seedBaselineLenders();
}

if (require.main === module) {
  seedDatabase()
    .then(async () => {
      await pool.end();
    })
    .catch(async (err) => {
      process.stderr.write(`${String(err)}\n`);
      await pool.end();
      process.exit(1);
    });
}
