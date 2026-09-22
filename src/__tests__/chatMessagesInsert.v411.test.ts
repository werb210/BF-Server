// BF_SERVER_CHAT_MESSAGES_COLUMNS_v411
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildMessageInsert } from "../modules/ai/chat.repo.js";

describe("v411 Maya transcripts survive a chat_messages column gap", () => {
  it("skips a column the table does not have (the live 'role' failure)", () => {
    const { sql, fields } = buildMessageInsert(new Set(["id", "session_id", "message", "metadata"]));
    expect(sql).not.toContain('"role"');
    expect(fields).not.toContain("role");
    expect(sql).toContain('"message"');
  });

  it("uses every column the table does have", () => {
    const { sql, fields } = buildMessageInsert(
      new Set(["id", "session_id", "role", "message", "content", "metadata"]),
    );
    expect(fields).toEqual(["id", "session_id", "role", "message", "content", "metadata"]);
    expect(sql).toContain("values ($1, $2, $3, $4, $5, $6::jsonb)");
  });

  it("keeps the jsonb cast on metadata wherever it lands", () => {
    const { sql } = buildMessageInsert(new Set(["id", "session_id", "metadata"]));
    expect(sql).toContain("$3::jsonb");
  });

  it("still writes something usable when only the bare minimum exists", () => {
    const { sql, fields } = buildMessageInsert(new Set(["id", "session_id"]));
    expect(fields).toEqual(["id", "session_id"]);
    expect(sql).toContain("values ($1, $2)");
  });

  it("the migration adds the missing columns idempotently", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "migrations/2026_09_22_v411_chat_messages_columns.sql"),
      "utf8",
    );
    for (const col of ["role", "message", "content", "metadata", "created_at"]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });
});
