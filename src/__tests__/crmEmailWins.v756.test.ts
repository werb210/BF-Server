// BF_SERVER_CRM_EMAIL_WINS_v756
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { withCrmEmail } from "../signnow/sendApplicationForSignature.js";
import { signerWithCrmEmail, type FeeSigner } from "../services/feeAgreement/mediaFeeAgreement.js";

const typed = "brandonvoss@vossevents.com";
const corrected = "brandon@vossevents.com";

describe("a corrected CRM email wins over the application email", () => {
  it("the application signer uses the CRM email; co-owners keep theirs", async () => {
    const owners = [{ email: typed, firstName: "Brandon" }, { email: "partner@x.com", firstName: "Pat" }];
    expect(await withCrmEmail("a1", owners, async () => corrected)).toEqual([{ email: corrected, firstName: "Brandon" }, { email: "partner@x.com", firstName: "Pat" }]);
  });
  it("with no CRM email the application email stays", async () => {
    const owners = [{ email: typed }];
    expect(await withCrmEmail("a1", owners, async () => null)).toBe(owners);
  });
  it("the fee agreement goes to the CRM email when the client signs it", async () => {
    const signer: FeeSigner = { name: "Brandon Voss", email: typed, phone: "+19173043342", title: null, isApplicant: true, reason: "applicant_fallback" };
    expect((await signerWithCrmEmail("a1", signer, async () => corrected)).email).toBe(corrected);
    expect((await signerWithCrmEmail("a1", signer, async () => null)).email).toBe(typed);
  });
  it("a director signing for the company keeps their own email", async () => {
    const director: FeeSigner = { name: "Dana Director", email: "dana@x.com", phone: null, title: "Director", isApplicant: false, reason: "director" };
    expect((await signerWithCrmEmail("a1", director, async () => corrected)).email).toBe("dana@x.com");
  });
  it("Send again updates the stored signer email, and both signing paths load through the CRM rule", () => {
    expect(readFileSync("src/services/feeAgreement/mediaFeeAgreement.ts", "utf8")).toContain("UPDATE media_fee_agreements SET signer_email=$2, updated_at=now() WHERE application_id=$1 AND status <> 'signed'");
    const s = readFileSync("src/signnow/sendApplicationForSignature.ts", "utf8");
    expect(s).toContain("owners: await withCrmEmail(applicationId, owners),");
    expect(s).toContain("applicantEmail: (await crmContactEmail(applicationId)) ?? owners[0]?.email ?? null,");
    expect(readFileSync("src/signnow/embeddedSigningSession.ts", "utf8")).toContain("loadApplicationForPdf(applicationId)");
  });
});
