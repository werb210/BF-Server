import { query } from "../db/db";

type UserInput = {
  email: string;
  password: string;
};

export async function create(data: UserInput) {
  const result = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, crypt($2, gen_salt('bf')))
     RETURNING id::text, email`,
    [data.email, data.password]
  );

  return result.rows[0] || null;
}

export async function findById(id: string) {
  const result = await query<{ id: string; email: string }>(
    "SELECT id::text, email FROM users WHERE id = $1",
    [id]
  );

  return result.rows[0] || null;
}

export async function update(id: string, data: Partial<UserInput>) {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (data.email) {
    values.push(data.email);
    updates.push(`email = $${values.length}`);
  }

  if (data.password) {
    values.push(data.password);
    updates.push(`password_hash = crypt($${values.length}, gen_salt('bf'))`);
  }

  if (!updates.length) {
    return findById(id);
  }

  values.push(id);

  const result = await query<{ id: string; email: string }>(
    `UPDATE users
     SET ${updates.join(", ")}
     WHERE id = $${values.length}
     RETURNING id::text, email`,
    values
  );

  return result.rows[0] || null;
}

export async function remove(id: string) {
  const result = await query<{ id: string }>("DELETE FROM users WHERE id = $1 RETURNING id::text", [id]);
  return result.rowCount > 0;
}
