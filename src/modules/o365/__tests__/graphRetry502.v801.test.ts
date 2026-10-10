// BF_SERVER_GRAPH_RETRY_v801
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const client = readFileSync(resolve(__dirname, "..", "graphClient.ts"), "utf-8");
describe("brief Microsoft gateway errors are retried for reads only", () => {
  it("502 and 504 join 429/503 in the retry loop", () => {
    expect(client).toContain("((resp.status === 429 || resp.status === 503) || transientGatewayRead(resp.status))");
    expect(client).toContain("isGet && (s === 502 || s === 504)");
  });
  it("only GET requests are retried on a gateway error (a send is never repeated)", () => {
    expect(client).toContain('const isGet = String(init.method ?? "GET").toUpperCase() === "GET";');
  });
});
