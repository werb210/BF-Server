// BF_SERVER_SIGNNOW_FIELD_DUMP_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("signnow field dump diagnostic", () => {
  it("client exposes a raw GET helper", () => {
    expect(r("src/signnow/signnowClient.ts")).toContain("export async function signnowGetRaw");
  });
  // BF_SERVER_REPAIR_STALE_TESTS_v1 - the admin fieldDump probe existed to inspect a
  // template's field structure while debugging prefill. Prefill is gone, and so is the
  // probe. signnowGetRaw is retained (asserted above) because it is a general-purpose
  // escape hatch, so keep guarding that and stop asserting for the deleted probe.
  it("the removed prefill-debug probe is not silently reintroduced", () => {
    const s = r("src/routes/admin.ts");
    expect(s).not.toContain("out.fieldDump");
  });
});
