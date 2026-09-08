// BF_SERVER_SERVICE_PRINCIPAL_v1
import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../../../observability/requestContext", () => ({ fetchRequestId: () => "req-1" }));

const { recordAuditEvent } = await import("../audit.service.js");
const client = { query, runQuery: query } as any;

function metadataOf() {
  const raw = query.mock.calls[0][1][10];
  return raw === null ? null : JSON.parse(String(raw));
}

describe("audit records who actually acted", () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it("marks a service action so it is separable from a human on the same role", async () => {
    await recordAuditEvent({
      actorUserId: "agent-service", targetUserId: null,
      action: "contact.note.create", success: true, serviceName: "maya-agent", client,
    });
    expect(metadataOf()).toMatchObject({ principal: "service", service: "maya-agent" });
  });

  it("preserves caller metadata alongside the principal", async () => {
    await recordAuditEvent({
      actorUserId: "agent-service", targetUserId: null,
      action: "contact.note.create", success: true, serviceName: "maya-agent",
      metadata: { contactId: "c-1" }, client,
    });
    expect(metadataOf()).toMatchObject({ contactId: "c-1", principal: "service" });
  });

  it("leaves human actions completely unchanged", async () => {
    await recordAuditEvent({
      actorUserId: "11111111-1111-1111-1111-111111111111", targetUserId: null,
      action: "contact.note.create", success: true, metadata: { contactId: "c-1" }, client,
    });
    expect(metadataOf()).toEqual({ contactId: "c-1" });
  });

  it("writes null metadata when a human action carries none", async () => {
    await recordAuditEvent({
      actorUserId: "11111111-1111-1111-1111-111111111111", targetUserId: null,
      action: "login", success: true, client,
    });
    expect(metadataOf()).toBeNull();
  });
});
