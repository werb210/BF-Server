// BF_SERVER_BLOCK_PNW_GATE_v1 — the lender-package PNW gate must BLOCK (false)
// when a PNW group exists but is unsigned, and PASS (true) when absent or signed.
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

describe("isPnwSignedOrAbsent (lender package PNW gate)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    statusMock.mockReset();
    keyMock.mockReset();
    keyMock.mockReturnValue(true);
  });

  it("returns true when no PNW signing group exists (PNW not in play)", async () => {
    answerGroup(null);
    const { isPnwSignedOrAbsent } = await load();
    expect(await isPnwSignedOrAbsent("app-1")).toBe(true);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("returns true when the PNW group is fully signed", async () => {
    answerGroup("grp-1");
    statusMock.mockResolvedValue({ signed: true, summary: "signed" });
    const { isPnwSignedOrAbsent } = await load();
    expect(await isPnwSignedOrAbsent("app-1")).toBe(true);
  });

  it("returns FALSE when the PNW group exists but is unsigned (blocks dispatch)", async () => {
    answerGroup("grp-1");
    statusMock.mockResolvedValue({ signed: false, summary: "pending" });
    const { isPnwSignedOrAbsent } = await load();
    expect(await isPnwSignedOrAbsent("app-1")).toBe(false);
  });

  it("returns FALSE on a status error rather than shipping unsigned", async () => {
    answerGroup("grp-1");
    statusMock.mockRejectedValue(new Error("signnow down"));
    const { isPnwSignedOrAbsent } = await load();
    expect(await isPnwSignedOrAbsent("app-1")).toBe(false);
  });
});
