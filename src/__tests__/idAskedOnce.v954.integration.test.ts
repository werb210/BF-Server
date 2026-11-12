// BF_SERVER_v954_ID_ASKED_ONCE - an identity check stands in for the "Government ID" required item (real Postgres).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { getSatisfiedDocTypes, idVerificationCovers } from "../routes/clientDocumentsNeeded.js";
import { canonicalDocKey } from "../services/documentKinds.js";

const A = randomUUID(), B = randomUUID();
const ids: string[] = [];
async function verification(applicationId: string, status: string) {
  const id = randomUUID(); ids.push(id);
  await pool.query(
    `INSERT INTO kyc_verifications (id, application_id, contact_id, person_role, provider, status, requested_via) VALUES ($1, $2, $3, 'applicant', 'manual', $4, 'staff')`,
    [id, applicationId, randomUUID(), status],
  );
}

describe("the client is asked for ID once", () => {
  afterAll(async () => { await pool.query(`DELETE FROM kyc_verifications WHERE id::text = ANY($1::text[])`, [ids]); });

  it("an open, in-review or approved identity check covers the Government ID item", async () => {
    expect(await idVerificationCovers(A)).toEqual([]);
    await verification(A, "requested");
    const covered = await idVerificationCovers(A);
    expect(covered.map(canonicalDocKey)).toEqual(["government_id"]);
    expect(canonicalDocKey("2 pieces of Government Issued ID")).toBe("government_id");
    expect((await getSatisfiedDocTypes(A)).map(canonicalDocKey)).toContain("government_id");
  });

  it("a declined, cancelled or expired check covers nothing", async () => {
    for (const s of ["declined", "cancelled", "expired"]) await verification(B, s);
    expect(await idVerificationCovers(B)).toEqual([]);
  });
});
