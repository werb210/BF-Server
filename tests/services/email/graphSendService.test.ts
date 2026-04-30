import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const ORIGINAL_ENV = { ...process.env };
function setEnv(env: Record<string, string | undefined>) { for (const [k,v] of Object.entries(env)) { if (v===undefined) delete process.env[k]; else process.env[k]=v; } }
describe("graphSendService", () => { beforeEach(() => { vi.restoreAllMocks(); process.env = { ...ORIGINAL_ENV }; }); afterEach(() => { process.env = { ...ORIGINAL_ENV }; });
it("returns config error when env vars missing", async () => { setEnv({MS_GRAPH_TENANT_ID:"",MS_GRAPH_CLIENT_ID:"",MS_GRAPH_CLIENT_SECRET:"",MS_GRAPH_SEND_AS:""}); const { sendViaGraph } = await import("../../../src/services/email/graphSendService"); const r = await sendViaGraph({ to:"x@y.com", subject:"s", bodyText:"b"}); expect(r.ok).toBe(false); });
});
