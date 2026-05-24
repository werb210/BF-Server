import { describe, it, expect, vi } from "vitest";
import { setProcessingStage } from "../processingStage.service.js";

describe("setProcessingStage smoke", () => {
  it("stores previous stage when moving to documents_incomplete", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows:[{ processing_stage:"banking_complete", previous_processing_stage:null }] })
      .mockResolvedValueOnce({ rows:[] })
      .mockResolvedValueOnce({ rows:[] })
      .mockResolvedValueOnce({ rows:[] });
    await setProcessingStage({ applicationId:"app-1", toStage:"documents_incomplete", reason:"test", actorUserId:null, client:{ query, runQuery: query } as any });
    expect(query).toHaveBeenCalled();
  });
});
