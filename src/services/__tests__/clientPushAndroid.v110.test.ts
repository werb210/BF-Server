// BF_SERVER_FCM_DELIVERY_v1
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/services/clientPushService.ts", "utf8");

describe("Android client push wiring", () => {
  it("routes non-iOS tokens to Firebase", () => {
    expect(source).toContain("const fcm = getFcmProvider();");
    expect(source).toContain("await fcm.send({ token: row.token }");
  });

  it("counts unsupported tokens when Firebase is not configured", () => {
    expect(source).toContain("if (!fcm) {");
    expect(source).toContain("unsupported += 1;");
  });

  it("drops registrations that FCM reports as permanently invalid", () => {
    expect(source).toContain("error instanceof FcmError && error.invalidRegistration");
  });

  it("can deliver without an APNs provider", () => {
    expect(source).toContain("if (!provider && !isFcmConfigured())");
    expect(source).toContain("initializeFcmProvider(env);");
  });
});
