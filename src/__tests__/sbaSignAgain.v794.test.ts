// BF_SERVER_SBA_SIGN_AGAIN_v794
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const routes = readFileSync("src/modules/applications/applications.routes.ts", "utf8");
const signing = readFileSync("src/signnow/sba/sbaSigning.ts", "utf8");
describe("signing an SBA file again", () => {
  it("resend-signing with again: true ignores the signed stamp on SBA files only", () => {
    const r = routes.slice(routes.indexOf("router.post('/:id/resend-signing'"));
    expect(r).toContain("const again = req.body?.again === true;");
    expect(r).toContain("signingBlockReason(signAgain ? { ...snapshot, applicationSigned: false } : snapshot)");
  });
  it("readiness tells the portal it is an SBA file", () => {
    expect(routes).toContain("isSba,");
  });
  it("a re-signed form replaces the old copy under Documents instead of being skipped", () => {
    const a = signing.slice(signing.indexOf("export async function attachSignedSbaDocuments"));
    expect(a).toContain("if (cur.rows[0]?.hash === newHash) continue;");
    expect(a).toContain("UPDATE documents SET hash = $2");
  });
});
