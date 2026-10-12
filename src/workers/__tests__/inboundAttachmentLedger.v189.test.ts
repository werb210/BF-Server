// BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { fileMock, graphFetch, putMock, captured } = vi.hoisted(() => ({
  fileMock: vi.fn(), graphFetch: vi.fn(), putMock: vi.fn(), captured: { tick: null as null | (() => Promise<void>) },
}));
vi.mock("../claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<void>) => { captured.tick = fn; return async () => undefined; } }));
vi.mock("../../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => ({ accessToken: "t", fetch: graphFetch })) }));
vi.mock("../../services/contactDocuments.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fileInboundAttachments: fileMock }));
vi.mock("../../lib/storage/index.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getStorage: () => ({ put: putMock }) }));

const migration = readFileSync("migrations/2026_09_15_v189_inbound_attachment_attempts.sql", "utf-8");

type Ledger = Map<string, { attempts: number; last_outcome: string | null }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makePool(ledger: Ledger, opts: { ledgerReadFails?: boolean; ledgerWriteFails?: boolean } = {}) {
  return {
    query: vi.fn(answerBySql([
      [/FROM users WHERE o365_refresh_token IS NOT NULL/, { rows: [{ id: "u1", silo: "BF" }] }],
      [/FROM shared_mailbox_settings/, { rows: [{ address: "info@boreal.financial", silo: "BI" }] }],
      [/SELECT attempts, last_outcome FROM inbound_attachment_attempts/, (_s: string, p?: unknown[]) => {
        if (opts.ledgerReadFails) return new Error("relation does not exist");
        const row = ledger.get(`${p![0]}:${p![1]}`);
        return { rows: row ? [row] : [] };
      }],
      [/INSERT INTO inbound_attachment_attempts/, (_s: string, p?: unknown[]) => {
        if (opts.ledgerWriteFails) return new Error("ledger write failed");
        const k = `${p![0]}:${p![1]}`;
        const cur = ledger.get(k);
        ledger.set(k, { attempts: (cur?.attempts ?? 0) + 1, last_outcome: String(p![2]) });
        return { rows: [], rowCount: 1 };
      }],
    ])),
  };
}

async function runTick(pool: ReturnType<typeof makePool>) {
  const { startInboundAttachmentWorker } = await import("../inboundAttachmentWorker.js");
  const w = startInboundAttachmentWorker(pool as any);
  await captured.tick!();
  w.stop();
}

beforeEach(() => {
  captured.tick = null;
  fileMock.mockReset();
  fileMock.mockResolvedValue({ filed: 1, contactId: "c1" });
  graphFetch.mockReset();
  graphFetch.mockImplementation(async () => json({ value: ["m-filed", "m-capped", "m-retry", "m-new"].map((id) => ({ id, hasAttachments: true })) }));
  process.env.MS_GRAPH_TENANT_ID = "tenant";
  process.env.MS_GRAPH_CLIENT_ID = "client";
  process.env.MS_GRAPH_CLIENT_SECRET = "secret";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("https://login.microsoftonline.com/")) return json({ access_token: "app-token", expires_in: 3600 });
    if (url.includes("/users/info%40boreal.financial/mailFolders/inbox/messages")) return json({ value: [{ id: "s-terminal", hasAttachments: true }, { id: "s-new", hasAttachments: true }] });
    return json({}, 404);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_GRAPH_TENANT_ID; delete process.env.MS_GRAPH_CLIENT_ID; delete process.env.MS_GRAPH_CLIENT_SECRET;
  vi.restoreAllMocks();
});

const seeded = (): Ledger => new Map([
  ["BF:m-filed", { attempts: 1, last_outcome: "filed" }],
  ["BF:m-capped", { attempts: 3, last_outcome: "retryable" }],
  ["BF:m-retry", { attempts: 2, last_outcome: "retryable" }],
  ["BI:s-terminal", { attempts: 1, last_outcome: "terminal" }],
]);
const filedIds = () => fileMock.mock.calls.map((c) => c[0].message.id);

describe("inbound attachment attempt ledger", () => {
  it("consults the ledger in both scan loops, not just the /me one", async () => {
    const ledger = seeded();
    const pool = makePool(ledger);
    await runTick(pool);
    expect(filedIds()).toEqual(["m-retry", "m-new", "s-new"]);
    expect(fileMock.mock.calls.find((c) => c[0].message.id === "s-new")![0]).toMatchObject({ base: "/users/info%40boreal.financial", silo: "BI" });
    expect(callsMatching(pool.query, /FROM inbound_attachment_attempts/).map((c) => (c[1] as unknown[]).join(":"))).toEqual(
      ["BF:m-filed", "BF:m-capped", "BF:m-retry", "BF:m-new", "BI:s-terminal", "BI:s-new"],
    );
    expect(ledger.get("BF:m-new")).toEqual({ attempts: 1, last_outcome: "filed" });
    expect(ledger.get("BI:s-new")).toEqual({ attempts: 1, last_outcome: "filed" });
  });

  it("caps retries so a message that files nothing is eventually left alone", async () => {
    const ledger: Ledger = new Map();
    fileMock.mockResolvedValue({ filed: 0, contactId: "c1", retryable: true });
    for (let i = 0; i < 5; i += 1) await runTick(makePool(ledger));
    expect(fileMock.mock.calls.filter((c) => c[0].message.id === "m-new")).toHaveLength(3);
    expect(ledger.get("BF:m-new")).toEqual({ attempts: 3, last_outcome: "retryable" });
  });

  it("treats a filed or terminal message as permanently done, and records each outcome", async () => {
    const ledger: Ledger = new Map();
    fileMock.mockImplementation(async ({ message }: any) => {
      if (message.id === "m-filed") return { filed: 2, contactId: "c1" };
      if (message.id === "m-capped") return { filed: 0, contactId: "c1", retryable: false };
      if (message.id === "m-retry") throw new Error("graph 503");
      return { filed: 0, contactId: "c1", retryable: true };
    });
    await runTick(makePool(ledger));
    expect(ledger.get("BF:m-filed")!.last_outcome).toBe("filed");
    expect(ledger.get("BF:m-capped")!.last_outcome).toBe("terminal");
    expect(ledger.get("BF:m-retry")!.last_outcome).toBe("retryable");
    fileMock.mockClear();
    await runTick(makePool(ledger));
    expect(filedIds()).not.toContain("m-filed");
    expect(filedIds()).not.toContain("m-capped");
    expect(filedIds()).toContain("m-retry");
  });

  it("never lets a ledger failure change the scan's behaviour", async () => {
    await runTick(makePool(seeded(), { ledgerReadFails: true, ledgerWriteFails: true }));
    expect(filedIds()).toEqual(["m-filed", "m-capped", "m-retry", "m-new", "s-terminal", "s-new"]);
  });
});

describe("skip classification", () => {
  async function file(atts: any[], opts: { putFails?: boolean; insertRowCount?: number; byIdStatus?: number } = {}) {
    const { fileInboundAttachments } = await vi.importActual<typeof import("../../services/contactDocuments.js")>("../../services/contactDocuments.js");
    putMock.mockReset();
    putMock.mockImplementation(async () => { if (opts.putFails) throw new Error("blob down"); return { blobName: "b", url: "u" }; });
    const pool = { query: vi.fn(answerBySql([
      [/FROM contacts WHERE silo = \$1 AND lower\(email\)/, { rows: [{ id: "c1" }] }],
      [/INSERT INTO contact_documents/, { rows: [], rowCount: opts.insertRowCount ?? 1 }],
    ])) };
    const graph = { accessToken: "t", fetch: vi.fn(async (path: string) => (/\/attachments\/[^/]+$/.test(path)
      ? json({}, opts.byIdStatus ?? 200)
      : json({ value: atts }))) };
    return fileInboundAttachments({ pool: pool as any, graph: graph as any, base: "/me", message: { id: "m1", hasAttachments: true, from: { emailAddress: { address: "a@b.co" } } }, silo: "BF" });
  }
  const pdf = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, name, contentType: "application/pdf", contentBytes: Buffer.from("x").toString("base64"), size: 1, ...extra });

  it("separates permanent skips from transient ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const permanent = await file([pdf("huge.pdf", { size: 30 * 1024 * 1024 }), { id: "item", name: "fwd.eml", contentBytes: undefined }]);
    expect(permanent).toMatchObject({ filed: 0, permanentSkips: 2, transientSkips: 0 });
    const transient = await file([pdf("a.pdf")], { putFails: true });
    expect(transient).toMatchObject({ filed: 0, permanentSkips: 0, transientSkips: 1 });
  });

  it("only marks a message retryable when a retry could actually help", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await file([pdf("a.pdf")], { putFails: true })).retryable).toBe(true);
    expect((await file([pdf("huge.pdf", { size: 30 * 1024 * 1024 })])).retryable).toBe(false);
    expect((await file([pdf("a.pdf")])).retryable).toBe(false); // filed
    expect((await file([pdf("a.pdf")], { insertRowCount: 0 })).retryable).toBe(false); // duplicate
  });

  it("logs the real status when the by-id attachment fetch fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await file([{ id: "att-1", name: "big.pdf", contentType: "application/pdf", size: 10 }], { byIdStatus: 429 });
    expect(err).toHaveBeenCalledWith("[file-to-crm] attachment fetch by id failed", { messageId: "m1", name: "big.pdf", status: 429 });
  });
});

describe("migration", () => {
  it("is idempotent", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS inbound_attachment_attempts");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("keys on silo and message id together", () => {
    expect(migration).toContain("PRIMARY KEY (silo, message_id)");
  });
});
