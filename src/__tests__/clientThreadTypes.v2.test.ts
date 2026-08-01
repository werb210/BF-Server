import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const client = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
const thread = client.slice(client.indexOf("WITH thread AS"), client.indexOf("LIMIT 200`"));

describe("BF_CLIENT_THREAD_TYPES_v2", () => {
  it("casts the parameter on every comparison it appears in", () => {
    // The bug: $1 was compared against applications.id and
    // communications_messages.application_id, which are different types, so no
    // single type could be deduced and the statement failed.
    expect(thread).toContain("WHERE id::text = ($1)::text");
    expect(thread).toContain("WHERE application_id::text = ($1)::text");
  });

  it("casts the contact comparison too", () => {
    expect(thread).toContain("contact_id::text = (SELECT contact_id::text FROM thread)");
  });

  it("leaves no uncast comparison behind", () => {
    expect(thread).not.toContain("WHERE id = $1");
    expect(thread).not.toContain("WHERE application_id = $1");
  });

  it("still returns the thread scoped to the contact", () => {
    // A client with several applications must still see the single
    // conversation staff see, not one thread per application.
    expect(thread).toContain("SELECT contact_id FROM applications");
    expect(thread).toContain("IS NOT NULL");
  });

  it("still anchors on the requested application", () => {
    expect(thread).toContain("($1)::text");
  });
});
