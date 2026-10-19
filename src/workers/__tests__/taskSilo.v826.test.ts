// BF_SERVER_v826_TASK_SILO - the abandoned-application call task always gets a silo tasks.silo accepts.
import { describe, expect, it } from "vitest";
import { taskSilo } from "../abandonedApplicationWorker.js";

describe("taskSilo", () => {
  it("maps any application silo to BF, BI or SLF", () => {
    expect(taskSilo("BF")).toBe("BF");
    expect(taskSilo("bi")).toBe("BI");
    expect(taskSilo(" slf ")).toBe("SLF");
    expect(taskSilo("bf")).toBe("BF");
    expect(taskSilo(null)).toBe("BF");
    expect(taskSilo("")).toBe("BF");
    expect(taskSilo("boreal")).toBe("BF");
  });
});
