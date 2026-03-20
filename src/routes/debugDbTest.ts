import crypto from "crypto";
import { Router } from "express";

import { pool } from "../lib/dbClient";

type DebugTable = "crm_contacts" | "users" | "lenders";

type ColumnMeta = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
};

const debugRouter = Router();

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function valueForColumn(columnName: string, dataType: string, runId: string): unknown {
  const lowerName = columnName.toLowerCase();

  if (dataType === "uuid") {
    return crypto.randomUUID();
  }
  if (dataType === "boolean") {
    return true;
  }
  if (dataType === "integer" || dataType === "smallint" || dataType === "bigint") {
    return 1;
  }
  if (dataType === "real" || dataType === "double precision" || dataType === "numeric") {
    return 1;
  }
  if (
    dataType === "timestamp without time zone" ||
    dataType === "timestamp with time zone" ||
    dataType === "date"
  ) {
    return new Date();
  }
  if (dataType === "json" || dataType === "jsonb") {
    return { runId, source: "debug-db-test" };
  }

  if (lowerName.includes("email")) {
    return `debug+${runId}@example.com`;
  }
  if (lowerName.includes("phone")) {
    return "0000000000";
  }

  return `debug-${runId}-${lowerName}`;
}

async function getExistingTable(): Promise<DebugTable | null> {
  const result = await pool.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY array_position($1::text[], table_name)
      LIMIT 1
    `,
    [["crm_contacts", "users", "lenders"]]
  );

  return (result.rows[0]?.table_name as DebugTable | undefined) ?? null;
}

async function insertAndReadFromUsers(runId: string) {
  const id = crypto.randomUUID();
  const email = `debug+${runId}@example.com`;

  const insert = await pool.query(
    `
      INSERT INTO users (id, email, password_hash, role, active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, role, active
    `,
    [id, email, "debug-db-test", "admin", true]
  );

  const read = await pool.query(
    `
      SELECT id, email, role, active
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return {
    insertedId: id,
    inserted: insert.rows[0],
    record: read.rows[0] ?? null,
  };
}

async function insertAndReadFromLenders(runId: string) {
  const id = crypto.randomUUID();

  const insert = await pool.query(
    `
      INSERT INTO lenders (id, name, country)
      VALUES ($1, $2, $3)
      RETURNING id, name, country
    `,
    [id, `Debug Lender ${runId}`, "US"]
  );

  const read = await pool.query(
    `
      SELECT id, name, country
      FROM lenders
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return {
    insertedId: id,
    inserted: insert.rows[0],
    record: read.rows[0] ?? null,
  };
}

async function insertAndReadFromCrmContacts(runId: string) {
  const columnsResult = await pool.query(
    `
      SELECT column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'crm_contacts'
      ORDER BY ordinal_position
    `
  );

  const allColumns = columnsResult.rows as ColumnMeta[];
  const requiredColumns = allColumns.filter(
    (column) =>
      column.is_nullable === "NO" &&
      column.column_default === null &&
      column.is_identity !== "YES"
  );

  if (requiredColumns.length === 0) {
    throw new Error("crm_contacts has no writable required columns for debug insert");
  }

  const columnNames = requiredColumns.map((column) => quoteIdentifier(column.column_name));
  const values = requiredColumns.map((column) => valueForColumn(column.column_name, column.data_type, runId));
  const placeholders = requiredColumns.map((_column, index) => `$${index + 1}`);

  const idColumn = allColumns.find((column) => column.column_name === "id");
  const returningColumns = idColumn ? 'RETURNING *' : "";

  const insert = await pool.query(
    `
      INSERT INTO crm_contacts (${columnNames.join(", ")})
      VALUES (${placeholders.join(", ")})
      ${returningColumns}
    `,
    values
  );

  const inserted = insert.rows[0] ?? null;

  let record = inserted;
  if (inserted && Object.prototype.hasOwnProperty.call(inserted, "id")) {
    const read = await pool.query(
      `
        SELECT *
        FROM crm_contacts
        WHERE id = $1
        LIMIT 1
      `,
      [inserted.id]
    );
    record = read.rows[0] ?? null;
  }

  return {
    insertedId: inserted?.id ?? null,
    inserted,
    record,
  };
}

debugRouter.get("/db-test", async (_req, res) => {
  // TEMPORARY ROUTE: remove after DB connectivity verification is complete.
  let usedTable: DebugTable | null = null;
  let insertedId: string | null = null;

  try {
    const runId = Date.now().toString(36);
    usedTable = await getExistingTable();

    if (!usedTable) {
      throw new Error("No test table found (checked: crm_contacts, users, lenders)");
    }

    let result;
    if (usedTable === "crm_contacts") {
      result = await insertAndReadFromCrmContacts(runId);
    } else if (usedTable === "users") {
      result = await insertAndReadFromUsers(runId);
    } else {
      result = await insertAndReadFromLenders(runId);
    }

    insertedId = result.insertedId;

    res.status(200).json({
      write: result.inserted ? "ok" : "failed",
      read: result.record ? "ok" : "failed",
      table: usedTable,
      record: result.record,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_db_error";

    res.status(500).json({
      write: "failed",
      read: "failed",
      error: message,
      table: usedTable,
    });
  } finally {
    if (usedTable && insertedId) {
      try {
        await pool.query(`DELETE FROM ${quoteIdentifier(usedTable)} WHERE id = $1`, [insertedId]);
      } catch {
        // best-effort cleanup only
      }
    }
  }
});

export default debugRouter;
