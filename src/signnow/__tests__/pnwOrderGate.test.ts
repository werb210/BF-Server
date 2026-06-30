// BF_SERVER_BLOCK_PNW_ORDER_GATE_v1 — PNW must be signed before app signing /
// before dispatch. pnwSigningSatisfied: true when not required, or required+signed.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function load() { vi.resetModules(); return await import("../pnwSigning.js"); }

describe("pnwSigningSatisfied (app-signing + dispatch ordering gate)", () => {
  beforeEach(() => { queryMock.mockReset(); statusMock.mockReset(); keyMock.mockReset(); keyMock.mockReturnValue(true); });

  it("PNW NOT required => satisfied (true), no signnow call", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { pnwSigningSatisfied } = await load();
    expect(await pnwSigningSatisfied("a")).toBe(true);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("PNW required + signed => satisfied (true)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [{ group_id: "g1" }] });
    statusMock.mockResolvedValueOnce({ signed: true, summary: "s" });
    const { pnwSigningSatisfied } = await load();
    expect(await pnwSigningSatisfied("a")).toBe(true);
  });

  it("PNW required + unsigned => NOT satisfied (false)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [{ group_id: "g1" }] });
    statusMock.mockResolvedValueOnce({ signed: false, summary: "p" });
    const { pnwSigningSatisfied } = await load();
    expect(await pnwSigningSatisfied("a")).toBe(false);
  });

  it("PNW required + never filled (no group) => NOT satisfied (false)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [{ group_id: null }] });
    const { pnwSigningSatisfied } = await load();
    expect(await pnwSigningSatisfied("a")).toBe(false);
  });
});
