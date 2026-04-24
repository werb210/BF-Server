import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleListCrmTimeline } from "../../../src/modules/crm/timeline.controller.js";
import * as timelineRepo from "../../../src/modules/crm/timeline.repo.js";

describe("handleListCrmTimeline", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns data as an array and includes total in meta when repo returns []", async () => {
    vi.spyOn(timelineRepo, "listCrmTimeline").mockResolvedValue([]);
    const req = {
      query: {
        entityType: "contact",
        entityId: "11111111-1111-1111-1111-111111111111",
      },
    } as any;
    const json = vi.fn();
    const res = { json } as any;

    await handleListCrmTimeline(req, res);

    expect(json).toHaveBeenCalledWith({
      success: true,
      data: [],
      meta: { page: 1, pageSize: 25, total: 0 },
    });
  });

  it("returns entries array in order and meta.total with count", async () => {
    const entries = [
      { id: "1", event_type: "crm_timeline" },
      { id: "2", event_type: "crm_timeline" },
      { id: "3", event_type: "crm_timeline" },
    ] as any[];
    vi.spyOn(timelineRepo, "listCrmTimeline").mockResolvedValue(entries as any);

    const req = {
      query: {
        page: "1",
        pageSize: "25",
        entityType: "contact",
        entityId: "11111111-1111-1111-1111-111111111111",
      },
    } as any;
    const json = vi.fn();
    const res = { json } as any;

    await handleListCrmTimeline(req, res);

    expect(json).toHaveBeenCalledWith({
      success: true,
      data: entries,
      meta: { page: 1, pageSize: 25, total: 3 },
    });
  });
});
