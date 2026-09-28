// BF_SERVER_DOC_SHARING_v635 (sharing - shipped as BF-Server v639)
import { describe, it, expect } from "vitest";
import { businessKey } from "../services/documentKinds.js";
import { planShares } from "../services/documentSharing.js";

describe("planShares", () => {
  const docs = [
    { id: "d1", application_id: "capital", app_name: "Todd's Gym", category: "Government ID", document_type: "general" },
    { id: "d2", application_id: "capital", app_name: "Todd's Gym", category: "6 months business banking statements", document_type: "bank" },
    { id: "d3", application_id: "other", app_name: "Todd's Other Co", category: "VOID cheque or PAD", document_type: "general" },
  ];
  it("shares personal documents from any of the client's applications", () => {
    const p = planShares([{ document_type: "2 pieces of Government Issued ID" }], businessKey("Different Business Ltd"), docs);
    expect(p.map((x) => x.source.id)).toEqual(["d1"]);
  });
  it("shares business documents only within the same business", () => {
    expect(planShares([{ document_type: "Bank statements" }], businessKey("TODDS GYM"), docs).map((x) => x.source.id)).toEqual(["d2"]);
    expect(planShares([{ document_type: "VOID cheque or PAD" }], businessKey("Todd's Gym"), docs)).toEqual([]);
    expect(planShares([{ document_type: "Bank statements" }], "", docs)).toEqual([]);
  });
});
