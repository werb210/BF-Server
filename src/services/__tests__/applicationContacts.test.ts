import { describe, expect, it, vi } from "vitest";
import { linkContactToApplication, unlinkContactFromApplication } from "../applicationContacts.js";

describe("applicationContacts service", () => {
  it("links and unlinks contact rows", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const client = { query } as any;

    await linkContactToApplication(
      client,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "partner"
    );
    await unlinkContactFromApplication(
      client,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "partner"
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("INSERT INTO application_contacts");
    expect(query.mock.calls[1][0]).toContain("DELETE FROM application_contacts");
  });
});
