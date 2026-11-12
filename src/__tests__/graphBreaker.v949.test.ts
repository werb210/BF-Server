// BF_SERVER_v949_GRAPH_BREAKER - when Microsoft's mail service is down, reads fail fast instead of piling up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGraphForUser, graphBreakerOpen, resetGraphBreaker } from "../modules/o365/graphClient.js";

const USER = "00000000-0000-4000-8000-000000000949";
const db = { query: vi.fn(async () => ({ rows: [{ o365_access_token: "tok", o365_refresh_token: null, o365_access_token_expires_at: new Date(Date.now() + 3600_000) }] })) } as any;
const res = (status: number) => new Response(JSON.stringify({ value: [] }), { status, headers: { "retry-after": "0" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => { resetGraphBreaker(); fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Microsoft mail breaker", () => {
  it("after a read ends in a gateway error, later reads fail at once without calling Microsoft", async () => {
    fetchMock.mockImplementation(async () => res(504));
    const graph = (await getGraphForUser(db, USER))!;
    const first = await graph.fetch("/me/mailFolders/Inbox/messages?$top=50");
    expect(first.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(3); // one try and two retries
    expect(graphBreakerOpen(USER)).toBe(true);

    const second = await graph.fetch("/users/info%40example.test/mailFolders/Inbox/messages");
    expect(second.status).toBe(504);
    expect(second.headers.get("x-bf-graph")).toBe("breaker");
    expect(fetchMock).toHaveBeenCalledTimes(3); // no new call
  });

  it("sending mail is never blocked by the breaker", async () => {
    fetchMock.mockImplementation(async () => res(502));
    const graph = (await getGraphForUser(db, USER))!;
    await graph.fetch("/me/messages");
    expect(graphBreakerOpen(USER)).toBe(true);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => res(202));
    const sent = await graph.fetch("/me/sendMail", { method: "POST", body: "{}" });
    expect(sent.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads are given a time limit, and a read that times out is not retried", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const graph = (await getGraphForUser(db, USER))!;
    const r = await graph.fetch("/me/mailFolders/Inbox/messages");
    expect(r.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(graphBreakerOpen(USER)).toBe(true);
  });

  it("the breaker closes again by itself, and a good read clears it", async () => {
    fetchMock.mockImplementation(async () => res(504));
    const graph = (await getGraphForUser(db, USER))!;
    await graph.fetch("/me/messages");
    expect(graphBreakerOpen(USER, Date.now() + 44_000)).toBe(true);
    expect(graphBreakerOpen(USER, Date.now() + 46_000)).toBe(false);
    resetGraphBreaker();
    fetchMock.mockImplementation(async () => res(200));
    expect((await graph.fetch("/me/messages")).status).toBe(200);
    expect(graphBreakerOpen(USER)).toBe(false);
  });

  it("one user's outage does not block another user's mail", async () => {
    fetchMock.mockImplementation(async () => res(504));
    await (await getGraphForUser(db, USER))!.fetch("/me/messages");
    expect(graphBreakerOpen("00000000-0000-4000-8000-000000000950")).toBe(false);
  });
});
