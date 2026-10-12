import { pool, runQuery } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { runMigrations } from "../startup/runMigrations.js"; // BF_SERVER_v789_DEAD_CODE - the one migration runner
import { logInfo } from "../observability/logger.js";

// BF_SERVER_NO_PERSONAL_NUMBERS_v688c - emergency admin logins come from App Service settings, never from code.
// With a setting missing, that seed is skipped (it only ever runs on an empty database or when asked).
const seedPhone = (raw: unknown): string | null => {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? "+1" + d : d.length === 11 && d.startsWith("1") ? "+" + d : null;
};
export const SEEDED_ADMIN_PHONE = seedPhone(process.env.BOOTSTRAP_ADMIN_PHONE) ?? "+14035550100";
export const SEEDED_ADMIN_ID = "00000000-0000-0000-0000-000000000099";
export const SEEDED_ADMIN_EMAIL = "seeded-admin@boreal.financial";
export const SEEDED_ADMIN2_PHONE = seedPhone(process.env.BOOTSTRAP_ADMIN2_PHONE) ?? "+14035550101";
export const SEEDED_ADMIN2_ID = "00000000-0000-0000-0000-000000000100";
export const SEEDED_ADMIN2_EMAIL = "seeded-admin-2@boreal.financial";
export const SEEDED_LENDER_ID = "00000000-0000-0000-0000-000000000200";
export const SEEDED_LENDER_PRODUCT_TERM_ID = "00000000-0000-0000-0000-000000000201";
export const SEEDED_LENDER_PRODUCT_LOC_ID = "00000000-0000-0000-0000-000000000202";

// BF_SERVER_v789_SEED_CREATE_ONLY - a bootstrap admin is CREATED when no user has
// that phone number, and nothing else. The old upsert (ON CONFLICT DO UPDATE)
// re-enabled, unlocked, re-roled and overwrote whichever account held the phone
// on every boot with BOOTSTRAP_ADMIN_PHONE set, so a disabled or demoted user
// came back as an active Admin. An existing user is never touched now.
async function createBootstrapAdminIfAbsent(
  label: string,
  id: string,
  email: string,
  phoneNumber: string,
): Promise<boolean> {
  const digits = phoneNumber.replace(/[^0-9]/g, "").slice(-10);
  const existing = await runQuery<{ id: string }>(
    `select id from users
      where phone_number = $1
         or phone = $1
         or right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = $2
         or right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
      limit 1`,
    [phoneNumber, digits],
  );
  if (existing.rows.length > 0) {
    console.log(`[seed] ${label}: a user already has this phone - left unchanged`);
    return false;
  }
  // ON CONFLICT DO NOTHING with no target: a clash on id, email or phone_number
  // (a concurrent boot, or the seeded id now holding another phone) is left
  // alone rather than overwritten.
  const inserted = await runQuery<{ id: string }>(
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
     on conflict do nothing
     returning id`,
    [id, email, phoneNumber, phoneNumber, ROLES.ADMIN],
  );
  const created = inserted.rows.length > 0;
  console.log(`[seed] ${label}: ${created ? "created" : "not created (a conflicting user exists) - left unchanged"}`);
  return created;
}

export async function seedAdminUser(): Promise<{ id: string; phoneNumber: string }> {
  const phoneNumber = SEEDED_ADMIN_PHONE;
  if (process.env.NODE_ENV === "production" && !seedPhone(process.env.BOOTSTRAP_ADMIN_PHONE)) {
    console.warn("[seed] BOOTSTRAP_ADMIN_PHONE not set - first admin not seeded");
    return { id: SEEDED_ADMIN_ID, phoneNumber };
  }
  await createBootstrapAdminIfAbsent("first admin", SEEDED_ADMIN_ID, SEEDED_ADMIN_EMAIL, phoneNumber);
  return { id: SEEDED_ADMIN_ID, phoneNumber };
}

export async function seedSecondAdminUser(): Promise<{
  id: string;
  phoneNumber: string;
}> {
  const phoneNumber = SEEDED_ADMIN2_PHONE;
  if (process.env.NODE_ENV === "production" && !seedPhone(process.env.BOOTSTRAP_ADMIN2_PHONE)) {
    console.warn("[seed] BOOTSTRAP_ADMIN2_PHONE not set - second admin not seeded");
    return { id: SEEDED_ADMIN2_ID, phoneNumber };
  }
  await createBootstrapAdminIfAbsent("second admin", SEEDED_ADMIN2_ID, SEEDED_ADMIN2_EMAIL, phoneNumber);
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
  await runMigrations(pool);
  await seedAdminUser();
  await seedSecondAdminUser();
  await seedBaselineLenders();
}

import { fileURLToPath } from "url";

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
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
