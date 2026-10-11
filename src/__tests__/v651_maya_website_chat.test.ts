// BF_SERVER_BLOCK_v651_MAYA_WEBSITE_CHAT_v1
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.resolve(__dirname, "..", "routes", "aiMayaAlias.ts"),
  "utf8",
);

describe("v651 — Maya website-chat alias", () => {
  it("registers POST /maya/website-chat", () => {
    expect(src).toMatch(/router\.post\(\s*['"]\/maya\/website-chat['"]/);
  });
  it("validates message presence with 400", () => {
    expect(src).toMatch(/missing_message/);
  });
  it("forwards to agent /api/maya/message via proxyMayaToAgent", () => {
    expect(src).toMatch(/proxyMayaToAgent\(\s*['"]\/api\/maya\/message['"]/);
  });
  // BF_SERVER_v784_MAYA_IDENTITY - the audience is derived from the verified token by
  // the proxy (X-Maya-Context), never put in the forwarded body.
  it("does not set a body audience", () => {
    expect(src).not.toMatch(/audience:\s*['"]visitor['"]/);
  });
});
