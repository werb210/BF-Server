// BF_SERVER_v956_CONDITION_CLIENT_WORDING - the client reads plain words; staff keep the lender's wording.
import { describe, it, expect } from "vitest";
import { clientView, parseConditionInput, rowToCondition } from "../brokerTools/conditions.js";

const row = (over: Record<string, unknown>) => rowToCondition({ id: "c1", application_id: "a1", title: "Executed PG from all principals", description: "Per section 4.2 of the commitment", owner: "client", status: "open", offer_id: "o1", ...over });

describe("what the client sees for a funding condition", () => {
  it("is the plain wording when there is one, without the lender's description", () => {
    const [c] = clientView([row({ client_title: "Sign the personal guarantee we send to each owner" })], "o1");
    expect(c).toMatchObject({ title: "Sign the personal guarantee we send to each owner", description: null });
  });
  it("falls back to the condition as written when no plain wording was given", () => {
    const [c] = clientView([row({ client_title: null })], "o1");
    expect(c).toMatchObject({ title: "Executed PG from all principals", description: "Per section 4.2 of the commitment" });
  });
  it("staff still get both wordings", () => {
    expect(row({ client_title: "Sign the personal guarantee" })).toMatchObject({ title: "Executed PG from all principals", client_title: "Sign the personal guarantee" });
    expect(row({}).client_title).toBeNull();
  });
  it("the plain wording can be set, changed and cleared", () => {
    const set = parseConditionInput({ client_title: "  Send a void cheque  " }, true);
    expect(set.ok && set.value.client_title).toBe("Send a void cheque");
    const cleared = parseConditionInput({ client_title: "" }, true);
    expect(cleared.ok && cleared.value.client_title).toBeNull();
    const untouched = parseConditionInput({ note: "x" }, true);
    expect(untouched.ok && "client_title" in untouched.value).toBe(false);
  });
});
