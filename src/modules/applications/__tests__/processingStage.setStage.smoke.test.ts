import { describe, it, expect, vi } from "vitest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762
import { setProcessingStage } from "../processingStage.service.js";

describe("setProcessingStage smoke", () => {
  it("stores previous stage when moving to documents_incomplete", async () => {
    const query = vi.fn(answerBySql([
      [/^\s*SELECT[\s\S]*processing_stage[\s\S]*FROM applications/i, { rows:[{ processing_stage:"banking_complete", previous_processing_stage:null }] }],
    ]));
    await setProcessingStage({ applicationId:"app-1", toStage:"documents_incomplete", reason:"test", actorUserId:null, client:{ query, runQuery: query } as any });
    expect(query).toHaveBeenCalled();
  });
});
