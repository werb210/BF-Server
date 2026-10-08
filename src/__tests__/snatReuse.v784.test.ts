// BF_SERVER_SNAT_REUSE_v784
import { describe, it, expect, vi } from "vitest";
vi.unmock("twilio"); // the shared test setup fakes twilio; this file checks the real keep-alive client
import net from "node:net";
import { readFileSync } from "node:fs";
import { sharedOpenAI, sharedTwilio } from "../lib/sharedClients.js";
import { summarizeSockets } from "../lib/netSockets.js";

describe("outbound clients are reused, so the server stops burning Azure SNAT ports", () => {
  it("one OpenAI client per key", () => {
    expect(sharedOpenAI("k1")).toBe(sharedOpenAI("k1"));
    expect(sharedOpenAI("k1")).not.toBe(sharedOpenAI("k2"));
  });
  it("one Twilio client per account, with keep-alive connections", () => {
    const a = sharedTwilio("AC" + "1".repeat(32), "tok");
    expect(sharedTwilio("AC" + "1".repeat(32), "tok")).toBe(a);
    expect(a.httpClient?.axios?.defaults?.httpsAgent?.keepAlive).toBe(true);
  });
  it("per-call clients are gone from the busy paths", () => {
    for (const f of ["src/routes/portal.ts", "src/routes/communications.ts", "src/telephony/routes/telephonyRoutes.ts", "src/routes/auth.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/=\s*twilio\(/);
    }
    for (const f of ["src/services/credit/financials.ts", "src/services/credit/collateral.ts", "src/services/credit/research.ts", "src/services/credit/creditSummaryV2.ts", "src/services/brokerImport/extract.ts", "src/modules/voice/voicemailEnrich.service.ts", "src/routes/reception.ts", "src/routes/settings.ts", "src/ai/aiChatController.ts", "src/services/banking/bankingAnalysisPipeline.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/new OpenAI\(\{ ?apiKey/);
    }
    expect(readFileSync("src/db.prod.ts", "utf8")).toContain("idleTimeoutMillis: 300_000,");
  });
  it("reports open outbound sockets by destination", async () => {
    const server = net.createServer((s) => s.on("error", () => undefined)).listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    const sock = net.connect(port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    const r = summarizeSockets();
    expect(r.byDestination[`127.0.0.1:${port}`]).toBeGreaterThanOrEqual(1);
    sock.destroy(); server.close();
  });
});
