// BF_SERVER_AUDIT_PRINCIPAL_CONTEXT_v1
import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
const { recordAuditEvent } = await import("../audit.service.js");
const { runWithRequestContext } = await import("../../../observability/requestContext.js");
const { markRequestServicePrincipal } = await import("../../../observability/requestContext.js");
const client = { query, runQuery: query } as any;
const audit = (params: Parameters<typeof recordAuditEvent>[0]) =>
  recordAuditEvent({ ...params, client });

function metadataOf() {
  const raw = query.mock.calls[0][1][10];
  return raw === null ? null : JSON.parse(String(raw));
}

describe("principal reaches untouched call sites", () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it("attributes a service action with no change at the call site", async () => {
    await runWithRequestContext(async () => {
      markRequestServicePrincipal("maya-agent");
      // Exactly what all 85 existing callers pass today.
      await audit({
        actorUserId: "agent-service", targetUserId: null,
        action: "contact.note.create", success: true,
      });
    });
    expect(metadataOf()).toMatchObject({ principal: "service", service: "maya-agent" });
  });

  it("leaves a human request untouched", async () => {
    await runWithRequestContext(async () => {
      await audit({
        actorUserId: "11111111-1111-1111-1111-111111111111", targetUserId: null,
        action: "contact.note.create", success: true, metadata: { contactId: "c-1" },
      });
    });
    expect(metadataOf()).toEqual({ contactId: "c-1" });
  });

  it("lets an explicit argument override the store", async () => {
    await runWithRequestContext(async () => {
      markRequestServicePrincipal("maya-agent");
      await audit({
        actorUserId: "svc", targetUserId: null, action: "x",
        success: true, serviceName: "dialer",
      });
    });
    expect(metadataOf()).toMatchObject({ service: "dialer" });
  });

  it("does not leak the principal across requests", async () => {
    await runWithRequestContext(async () => { markRequestServicePrincipal("maya-agent"); });
    await runWithRequestContext(async () => {
      await audit({ actorUserId: "u", targetUserId: null, action: "x", success: true });
    });
    expect(metadataOf()).toBeNull();
  });

  it("survives outside any request context", async () => {
    await audit({ actorUserId: "u", targetUserId: null, action: "x", success: true });
    expect(metadataOf()).toBeNull();
  });
});
