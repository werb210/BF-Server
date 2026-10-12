// BF_SERVER_BLOCK_PNW_ORDER_GATE_v2 — gate anchored on the PNW signing group.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS

const { queryMock, statusMock, keyMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  statusMock: vi.fn(),
  keyMock: vi.fn(() => true),
}));

vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, dbQuery: queryMock };
});

vi.mock("../signnowClient", async () => {
  const actual = await vi.importActual<typeof import("../signnowClient.js")>("../signnowClient");
  return { ...actual, isApiKeyConfigured: keyMock, getDocumentGroupStatus: statusMock };
});

// BF_SERVER_v789_SQL_CONTENT_MOCKS - the PNW group lookup is answered by SQL text, not by call order.
function answerGroup(groupId: string | null) {
  queryMock.mockImplementation(answerBySql([[/AS group_id/, { rows: [{ group_id: groupId }] }]]));
}

async function load() {
  vi.resetModules();
  return await import("../pnwSigning.js");
}

describe("PNW ordering gate v2 (group-presence anchored)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    statusMock.mockReset();
    keyMock.mockReset();
    keyMock.mockReturnValue(true);
  });

  it("app-signing: no PNW group => allowed", async () => {
    answerGroup(null);
    const { pnwSigningSatisfiedForAppSigning } = await load();
    expect(await pnwSigningSatisfiedForAppSigning("a")).toBe(true);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("app-signing: group + signed => allowed", async () => {
    answerGroup("g");
    statusMock.mockResolvedValue({ signed: true, summary: "s" });
    const { pnwSigningSatisfiedForAppSigning } = await load();
    expect(await pnwSigningSatisfiedForAppSigning("a")).toBe(true);
  });

  it("app-signing: group + UNSIGNED => blocked", async () => {
    answerGroup("g");
    statusMock.mockResolvedValue({ signed: false, summary: "p" });
    const { pnwSigningSatisfiedForAppSigning } = await load();
    expect(await pnwSigningSatisfiedForAppSigning("a")).toBe(false);
  });

  it("app-signing: group + status ERROR => allowed (no freeze during outage)", async () => {
    answerGroup("g");
    statusMock.mockRejectedValue(new Error("down"));
    const { pnwSigningSatisfiedForAppSigning } = await load();
    expect(await pnwSigningSatisfiedForAppSigning("a")).toBe(true);
  });

  it("dispatch: group + status ERROR => requeue (false)", async () => {
    answerGroup("g");
    statusMock.mockRejectedValue(new Error("down"));
    const { pnwSigningSatisfiedForDispatch } = await load();
    expect(await pnwSigningSatisfiedForDispatch("a")).toBe(false);
  });

  it("dispatch: group + signed => satisfied", async () => {
    answerGroup("g");
    statusMock.mockResolvedValue({ signed: true, summary: "s" });
    const { pnwSigningSatisfiedForDispatch } = await load();
    expect(await pnwSigningSatisfiedForDispatch("a")).toBe(true);
  });
});
