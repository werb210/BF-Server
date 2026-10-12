// BF_SERVER_v789_SG3_BOOT_INDEX - boots src/index.ts for behaviour tests.
//
// Every module src/index.ts imports (statically or inside start()) is replaced
// with a stub, so start() runs end to end without a database, a port or a real
// worker. Each worker start, worker stop, timer, listen, pool.end and exit is
// recorded in one ordered `events` list, so tests can assert WHAT the boot does
// and in which order, instead of grepping the source text.
//
//   const boot = await bootIndex({ nodeEnv: "production-like" });
//   await boot.workersDone();
//   expect(boot.started()).toContain("startFxRateWorker");
//   boot.restore();
//
// restore() unregisters every module mock bootIndex installed (vi.doUnmock), which also drops a
// vi.mock the test file itself declared for the same module (e.g. "../db.js"). Import what the
// rest of the test needs statically, at the top of the file, rather than dynamically after a boot.
import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const mod = (rel: string) => path.join(SRC, rel.replace(/\.js$/, ".ts"));

/** Worker modules started inside the gated block of start(), with their start export. */
export const WORKER_MODULES: Array<[string, string]> = [
  ["modules/ocr/ocr.worker.js", "startOcrWorker"],
  ["workers/bankingAutoWorker.js", "startBankingAutoWorker"],
  ["workers/lenderPackageWorker.js", "startLenderPackageWorker"],
  ["workers/signnowCompletionPoller.js", "startSignNowCompletionPoller"],
  ["workers/readReceiptWorker.js", "startReadReceiptWorker"],
  ["workers/tamperScanWorker.js", "startTamperScanWorker"],
  ["workers/inboundAttachmentWorker.js", "startInboundAttachmentWorker"],
  ["workers/abandonedApplicationWorker.js", "startAbandonedApplicationWorker"],
  ["workers/automationWorker.js", "startAutomationWorker"],
  ["workers/emailFollowupWorker.js", "startEmailFollowupWorker"],
  ["workers/productKnowledgeWorker.js", "startProductKnowledgeWorker"],
  ["workers/adsWeeklyEmailWorker.js", "startAdsWeeklyEmailWorker"],
  ["workers/googleAdsWarehouseWorker.js", "startGoogleAdsWarehouseWorker"],
  ["workers/marketingKnowledgeWorker.js", "startMarketingKnowledgeWorker"],
  ["workers/bookingsWorker.js", "startBookingsWorker"],
  ["workers/teamReminderWorker.js", "startTeamReminderWorker"],
  ["workers/teamsTranscriptWorker.js", "startTeamsTranscriptWorker"],
  ["workers/biOutreachEmailReplyWorker.js", "startBiOutreachEmailReplyWorker"],
  ["workers/graphSubscriptionWorker.js", "startGraphSubscriptionWorker"],
  ["workers/scheduledEmailWorker.js", "startScheduledEmailWorker"],
  ["workers/smsCascadeWorker.js", "startSmsCascadeWorker"],
  ["workers/sendQueueWorker.js", "startSendQueueWorker"],
  ["workers/deadLetterWorker.js", "startDeadLetterWorker"],
  ["workers/sequenceWorker.js", "startSequenceWorker"],
  ["workers/mailReplyWorker.js", "startMailReplyWorker"],
  ["workers/adConversionWorker.js", "startAdConversionWorker"],
  ["workers/todoReconcileWorker.js", "startTodoReconcileWorker"],
  ["workers/taskRemindersWorker.js", "startTaskRemindersWorker"],
  ["services/biHandoffRetry.js", "startBiHandoffRetryWorker"],
  ["workers/fxRateWorker.js", "startFxRateWorker"],
  ["workers/pipelineSnapshotWorker.js", "startPipelineSnapshotWorker"],
  ["workers/lenderBounceWorker.js", "startLenderBounceWorker"],
];

export type BootOptions = {
  /** NODE_ENV while start() runs (default "development": the worker block is live). */
  nodeEnv?: string;
  /** NODE_ENV while src/index.ts is imported. Anything but "test" auto-runs start(). Default "test". */
  importNodeEnv?: string;
  /** Extra env for the boot (undefined deletes the variable). Restored by restore(). */
  env?: Record<string, string | undefined>;
  /** Call start() after importing (default true; ignored when importNodeEnv auto-starts). */
  callStart?: boolean;
  /** Worker start exports that throw when called. */
  failWorkers?: string[];
  /** Overrides for stubs: initDb, runMigrations, backfillTemplateLandingPages, closeWorkerLocks, backfillPgiMirrors, listRoutes. */
  stubs?: Partial<Record<string, (...args: any[]) => any>>;
};

export type Boot = {
  index: Record<string, any>;
  events: string[];
  logs: Array<{ level: "log" | "warn" | "error"; args: unknown[] }>;
  handlers: Map<string, Array<(...args: any[]) => unknown>>;
  exitCodes: number[];
  timeouts: number[];
  workerCalls: Map<string, unknown[][]>;
  pool: { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stubs: Record<string, ReturnType<typeof vi.fn>>;
  startPromise: Promise<void> | null;
  /** Worker start exports, in the order they were called. */
  started(): string[];
  /** Resolves once the worker block has registered its SIGTERM handler (i.e. finished). */
  workersDone(): Promise<void>;
  logText(level?: "log" | "warn" | "error"): string;
  restore(): void;
};

async function settle(events: string[], handlers: Map<string, unknown>, realSetTimeout: typeof setTimeout): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
  let seen = -1;
  let quietSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (handlers.has("SIGTERM")) return;
    if (events.length !== seen) { seen = events.length; quietSince = Date.now(); }
    else if (Date.now() - quietSince > 150) return;
    await sleep(5);
  }
  throw new Error("bootIndex: start() did not settle within 10s");
}

export async function bootIndex(opts: BootOptions = {}): Promise<Boot> {
  vi.resetModules();
  const events: string[] = [];
  const logs: Boot["logs"] = [];
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const exitCodes: number[] = [];
  const timeouts: number[] = [];
  const workerCalls = new Map<string, unknown[][]>();
  const fail = new Set(opts.failWorkers ?? []);
  const savedEnv = { ...process.env };

  const spies: Array<{ mockRestore(): void }> = [];
  spies.push(
    vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...args: any[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      events.push(`on:${event}`);
      return process;
    }) as any),
  );
  spies.push(
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(Number(code ?? 0));
      events.push(`exit:${Number(code ?? 0)}`);
      return undefined as never;
    }) as any),
  );
  for (const level of ["log", "warn", "error"] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push({ level, args }); }));
  }
  // Collapse every timer to 0 ms but remember what was asked for (worker stagger, PGI backfill delay).
  const realSetTimeout = globalThis.setTimeout;
  spies.push(
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
      timeouts.push(Number(ms ?? 0));
      events.push(`timeout:${Number(ms ?? 0)}`);
      return realSetTimeout(fn, 0, ...rest);
    }) as any),
  );

  const stub = (name: string, impl: (...args: any[]) => any) => vi.fn(opts.stubs?.[name] ?? impl);
  const stubs: Record<string, ReturnType<typeof vi.fn>> = {
    initDb: stub("initDb", async () => { events.push("initDb"); }),
    runMigrations: stub("runMigrations", async () => { events.push("runMigrations"); }),
    backfillTemplateLandingPages: stub("backfillTemplateLandingPages", async () => { events.push("templateBackfill"); return { scanned: 0, repaired: 0 }; }),
    verifyRequiredTables: stub("verifyRequiredTables", async () => { events.push("verifyRequiredTables"); }),
    closeWorkerLocks: stub("closeWorkerLocks", async () => { events.push("closeWorkerLocks"); }),
    backfillPgiMirrors: stub("backfillPgiMirrors", async (n: number) => { events.push(`backfillPgiMirrors:${n}`); }),
    ensureSignnowWebhook: stub("ensureSignnowWebhook", async () => { events.push("ensureSignnowWebhook"); }),
    listRoutes: stub("listRoutes", () => [
      { method: "POST", path: "/api/auth/otp/start" },
      { method: "POST", path: "/api/auth/otp/verify" },
    ]),
    assertJwtSecretAtStartup: stub("assertJwtSecretAtStartup", () => undefined),
    listen: stub("listen", (_port: unknown, _host: unknown, cb?: () => void) => {
      events.push("listen");
      setImmediate(() => { events.push("listening"); cb?.(); });
      return { close: () => undefined };
    }),
    markReady: stub("markReady", () => { events.push("markReady"); }),
  };
  const pool = {
    query: vi.fn(async (sql: unknown) => (String(sql).includes("FROM users WHERE role = 'Admin'") ? { rows: [{ count: 1 }] } : { rows: [], rowCount: 0 })),
    end: vi.fn(async () => { events.push("pool.end"); }),
  };

  const mocked: string[] = [];
  const doMock = (rel: string, factory: () => Record<string, unknown>) => { mocked.push(mod(rel)); vi.doMock(mod(rel), factory); };
  doMock("system/errors.js", () => ({}));
  doMock("app.js", () => ({ createApp: () => ({ listen: stubs.listen }) }));
  doMock("db/init.js", () => ({ initDb: stubs.initDb }));
  doMock("db/tableHealthCheck.js", () => ({ verifyRequiredTables: stubs.verifyRequiredTables }));
  doMock("debug/printRoutes.js", () => ({ listRoutes: stubs.listRoutes }));
  doMock("security/ssnCrypto.js", () => ({ pgcryptoAvailable: async () => true }));
  doMock("startupState.js", () => ({ markReady: stubs.markReady }));
  doMock("ops/keepWarm.js", () => ({ startKeepWarm: () => undefined }));
  doMock("ws/teamSocket.js", () => ({ initTeamWebSocket: () => undefined }));
  doMock("services/email/graphSendService.js", () => ({ logGraphConfigStatus: () => undefined }));
  doMock("services/clientPushService.js", () => ({ initializeClientPushProvider: () => false }));
  doMock("watch/initWatchPush.js", () => ({ initializeWatchPushProvider: () => false }));
  doMock("startup/jwtSecretPolicy.js", () => ({ assertJwtSecretAtStartup: stubs.assertJwtSecretAtStartup }));
  doMock("modules/auth/otpHashSalt.js", () => ({ warnIfOtpHashSaltDerived: () => undefined }));
  doMock("modules/diagnostics/pushConfig.js", () => ({ pushConfigSummary: () => "stub" }));
  doMock("db.js", () => ({ pool }));
  doMock("startup/runMigrations.js", () => ({ runMigrations: stubs.runMigrations }));
  doMock("startup/templateLandingBackfill.js", () => ({ backfillTemplateLandingPages: stubs.backfillTemplateLandingPages }));
  doMock("db/seed.js", () => ({ seedAdminUser: async () => undefined, seedSecondAdminUser: async () => undefined }));
  doMock("signnow/ensureWebhookSubscription.js", () => ({ ensureSignnowWebhook: stubs.ensureSignnowWebhook }));
  doMock("workers/claim.js", () => ({ closeWorkerLocks: stubs.closeWorkerLocks }));
  doMock("lib/netSockets.js", () => ({ startSocketReport: () => undefined }));
  doMock("services/biDocMirror.js", () => ({ backfillPgiMirrors: stubs.backfillPgiMirrors }));

  for (const [rel, name] of WORKER_MODULES) {
    const fn = vi.fn((...args: unknown[]) => {
      const calls = workerCalls.get(name) ?? [];
      calls.push(args);
      workerCalls.set(name, calls);
      if (fail.has(name)) {
        events.push(`fail:${name}`);
        throw new Error(`${name} exploded`);
      }
      events.push(`start:${name}`);
      if (name === "startGraphSubscriptionWorker") return 0;
      return { stop: () => { events.push(`stop:${name}`); } };
    });
    if (rel === "services/biHandoffRetry.js") continue; // mocked together below
    doMock(rel, () => ({ [name]: fn }));
    stubs[name] = fn;
  }
  {
    const name = "startBiHandoffRetryWorker";
    const fn = vi.fn((...args: unknown[]) => {
      workerCalls.set(name, [...(workerCalls.get(name) ?? []), args]);
      if (fail.has(name)) { events.push(`fail:${name}`); throw new Error(`${name} exploded`); }
      events.push(`start:${name}`);
      return { stop: () => { events.push(`stop:${name}`); } };
    });
    stubs[name] = fn;
    doMock("services/biHandoffRetry.js", () => ({ [name]: fn }));
  }

  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.NODE_ENV = opts.importNodeEnv ?? "test";
  const index = (await import(mod("index.js"))) as Record<string, any>;
  process.env.NODE_ENV = opts.nodeEnv ?? "development";

  let startPromise: Promise<void> | null = null;
  if ((opts.importNodeEnv ?? "test") === "test" && opts.callStart !== false) {
    startPromise = index.start();
    await startPromise;
  }
  // The worker block runs in the background after start() returns. Let it finish (it registers
  // SIGTERM last) or go quiet, so nothing keeps running once the test restores the real timers.
  await settle(events, handlers, realSetTimeout);

  const boot: Boot = {
    index,
    events,
    logs,
    handlers,
    exitCodes,
    timeouts,
    workerCalls,
    pool,
    stubs,
    startPromise,
    started: () => events.filter((e) => e.startsWith("start:")).map((e) => e.slice(6)),
    async workersDone() {
      await vi.waitFor(() => {
        if (!handlers.has("SIGTERM")) throw new Error("worker block not finished");
      }, { timeout: 10_000, interval: 5 });
    },
    logText(level) {
      return logs.filter((l) => !level || l.level === level).map((l) => l.args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")).join("\n");
    },
    restore() {
      for (const s of spies.reverse()) s.mockRestore();
      process.env = { ...savedEnv };
      for (const m of mocked) vi.doUnmock(m);
      vi.resetModules();
    },
  };
  return boot;
}
