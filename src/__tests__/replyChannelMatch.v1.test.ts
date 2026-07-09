// BF_SERVER_REPLY_CHANNEL_MATCH_v1 - the template "replies" metric must only
// count inbound messages whose channel matches the template's send channel.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("template replies channel match v1", () => {
  const s = read("src/routes/marketing.ts");

  it("the LATERAL pulls the template channel", () => {
    expect(s).toContain("SELECT e.template_id, e.channel");
  });

  it("the replies subquery requires the inbound channel to match the template channel", () => {
    expect(s).toContain("AND m.type = tse.channel");
  });

  it("carries the sentinel", () => {
    expect(s).toContain("BF_SERVER_REPLY_CHANNEL_MATCH_v1");
  });
});
