"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEEDED_LENDER_PRODUCT_LOC_ID = exports.SEEDED_LENDER_PRODUCT_TERM_ID = exports.SEEDED_LENDER_ID = exports.SEEDED_ADMIN2_EMAIL = exports.SEEDED_ADMIN2_ID = exports.SEEDED_ADMIN2_PHONE = exports.SEEDED_ADMIN_EMAIL = exports.SEEDED_ADMIN_ID = exports.SEEDED_ADMIN_PHONE = void 0;
exports.seedAdminUser = seedAdminUser;
exports.seedSecondAdminUser = seedSecondAdminUser;
exports.seedBaselineLenders = seedBaselineLenders;
exports.seedDatabase = seedDatabase;
const db_1 = require("../db");
const roles_1 = require("../auth/roles");
const migrations_1 = require("../migrations");
const logger_1 = require("../observability/logger");
exports.SEEDED_ADMIN_PHONE = "+15878881837";
exports.SEEDED_ADMIN_ID = "00000000-0000-0000-0000-000000000099";
exports.SEEDED_ADMIN_EMAIL = "seeded-admin@boreal.financial";
exports.SEEDED_ADMIN2_PHONE = "+1-780-264-8467";
exports.SEEDED_ADMIN2_ID = "00000000-0000-0000-0000-000000000100";
exports.SEEDED_ADMIN2_EMAIL = "seeded-admin-2@boreal.financial";
exports.SEEDED_LENDER_ID = "00000000-0000-0000-0000-000000000200";
exports.SEEDED_LENDER_PRODUCT_TERM_ID = "00000000-0000-0000-0000-000000000201";
exports.SEEDED_LENDER_PRODUCT_LOC_ID = "00000000-0000-0000-0000-000000000202";
async function seedAdminUser() {
    const phoneNumber = exports.SEEDED_ADMIN_PHONE;
    await (0, db_1.runQuery)(`insert into users (
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
           phone_verified = excluded.phone_verified`, [exports.SEEDED_ADMIN_ID, exports.SEEDED_ADMIN_EMAIL, phoneNumber, phoneNumber, roles_1.ROLES.ADMIN]);
    return { id: exports.SEEDED_ADMIN_ID, phoneNumber };
}
async function seedSecondAdminUser() {
    const phoneNumber = exports.SEEDED_ADMIN2_PHONE;
    await (0, db_1.runQuery)(`insert into users (
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
           phone_verified = excluded.phone_verified`, [exports.SEEDED_ADMIN2_ID, exports.SEEDED_ADMIN2_EMAIL, phoneNumber, phoneNumber, roles_1.ROLES.ADMIN]);
    return { id: exports.SEEDED_ADMIN2_ID, phoneNumber };
}
async function seedBaselineLenders() {
    const { rows: tableRows } = await (0, db_1.runQuery)(`select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('lenders', 'lender_products')`);
    const tableSet = new Set(tableRows.map((row) => row.table_name));
    if (!tableSet.has("lenders") || !tableSet.has("lender_products")) {
        (0, logger_1.logInfo)("baseline_lenders_seed_skipped", {
            reason: "tables_missing",
            lendersTableExists: tableSet.has("lenders"),
            lenderProductsTableExists: tableSet.has("lender_products"),
        });
        return;
    }
    const { rows } = await (0, db_1.runQuery)("select count(*)::int as count from lenders");
    if ((rows[0]?.count ?? 0) > 0) {
        return;
    }
    await (0, db_1.runQuery)(`insert into lenders
     (id, name, active, status, submission_method, website, country, created_at, updated_at)
     values ($1, $2, true, 'ACTIVE', 'email', $3, $4, now(), now())`, [
        exports.SEEDED_LENDER_ID,
        "Atlas Capital",
        "https://atlascapital.example.com",
        "US",
    ]);
    await (0, db_1.runQuery)(`insert into lender_products
     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values
     ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'MONTHS', true, $11, now(), now()),
     ($12, $2, $13, $14, $15, $16, $17, $18, $19, $20, 'MONTHS', true, $21, now(), now())`, [
        exports.SEEDED_LENDER_PRODUCT_TERM_ID,
        exports.SEEDED_LENDER_ID,
        "Term Loan",
        "TERM",
        "US",
        "FIXED",
        "8.0",
        "12.0",
        12,
        60,
        JSON.stringify([{ type: "bank_statement", months: 6 }]),
        exports.SEEDED_LENDER_PRODUCT_LOC_ID,
        "Line of Credit",
        "LOC",
        "US",
        "VARIABLE",
        "P+",
        "P+",
        6,
        24,
        JSON.stringify([{ type: "bank_statement", months: 6 }]),
    ]);
}
async function seedDatabase() {
    await (0, migrations_1.runMigrations)();
    await seedAdminUser();
    await seedSecondAdminUser();
    await seedBaselineLenders();
}
if (require.main === module) {
    seedDatabase()
        .then(async () => {
        await db_1.pool.end();
    })
        .catch(async (err) => {
        process.stderr.write(`${String(err)}\n`);
        await db_1.pool.end();
        process.exit(1);
    });
}
