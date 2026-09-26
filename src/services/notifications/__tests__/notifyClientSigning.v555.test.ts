// BF_SERVER_BLOCK_v555
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { notifyClient } from "../notifyClient.js";

describe("v555 signing notices and SMS tracking", () => {
  it("SMS carries delivery tracking (defaults to the notice kind)", async () => {
    const sms = vi.fn(async () => undefined);
    await notifyClient(
      { phone: "4035550199", applicationId: "a1", kind: "owner1_signing", sms: "x", title: "t", body: "b" },
      { pushReady: async () => false, pushUsersForPhone: async () => [], push: async () => 0, sms, record: async () => undefined },
    );
    expect(sms).toHaveBeenCalledWith("4035550199", "x", { kind: "owner1_signing", applicationId: "a1" });
  });
  it("both signing notices go through notifyClient", () => {
    for (const f of ["src/signnow/ownerSigningNotice.ts", "src/signnow/embeddedSigningSession.ts"]) {
      const s = readFileSync(f, "utf-8");
      expect(s).toContain('kind: "owner1_signing", categoryId: "APPLICATION_UPDATE"');
      expect(s).toContain('if (sent.channel === "none") throw new Error');
    }
  });
});
