// BF_SERVER_AUDIT_METADATA_v1
import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../../../db.js", () => ({ pool: { query }, runQuery: query }));

const { listAuditEvents } = await import("../audit.repo.js");

function sqlOf() { return String(query.mock.calls[0][0]); }

describe("audit listing exposes attribution", () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it("selects metadata, where the principal lives", async () => {
    await listAuditEvents({ limit: 50, offset: 0, client: { query } as never });
    expect(sqlOf()).toContain("metadata");
  });

  it("filters to service actions", async () => {
    await listAuditEvents({ limit: 50, offset: 0, principal: "service", client: { query } as never });
    expect(sqlOf()).toContain("metadata->>'principal' = 'service'");
  });

  it("treats rows with no principal as human", async () => {
    // Every pre-existing row has null metadata; those are human actions.
    await listAuditEvents({ limit: 50, offset: 0, principal: "human", client: { query } as never });
    expect(sqlOf()).toContain("is distinct from 'service'");
  });

  it("applies no principal clause when unfiltered", async () => {
    await listAuditEvents({ limit: 50, offset: 0, client: { query } as never });
    expect(sqlOf()).not.toContain("principal");
  });

  it("keeps every filter parameterised", async () => {
    await listAuditEvents({
      limit: 50,
      offset: 0,
      actorUserId: "u-1",
      principal: "service",
      client: { query } as never,
    });
    // The principal clause is a fixed literal, never interpolated input.
    expect(sqlOf()).toContain("actor_user_id = $1");
    expect(query.mock.calls[0][1]).toEqual(["u-1", 50, 0]);
  });
});
