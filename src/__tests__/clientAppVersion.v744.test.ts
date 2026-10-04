// BF_SERVER_CLIENT_APP_VERSION_v744
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("client app version check", () => {
  it("serves the minimum app build before the client sign-in checks", () => {
    const s = readFileSync("src/routes/client/index.ts", "utf8");
    const route = s.indexOf('router.get("/app-version"');
    expect(route).toBeGreaterThan(-1);
    expect(route).toBeLessThan(s.indexOf("router.use((req: any, res: any, next: any) => {"));
    expect(s).toContain("CLIENT_APP_MIN_BUILD");
  });
});
