// BF_SERVER_OWNER_INVITE_QUEUE_WALK_v107
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { postSignnowWebhook, signnowWebhookApp } from "../../__tests__/helpers/signnowWebhook.js";

const { dbQuery, linkMock, sendMock, groupStatus } = vi.hoisted(() => ({ dbQuery: vi.fn(), linkMock: vi.fn(), sendMock: vi.fn(), groupStatus: vi.fn() }));
vi.mock("../../db.js", () => ({ dbQuery, pool: { query: dbQuery } }));
vi.mock("../../signnow/signnowClient.js", () => ({ createEmbeddedGroupLink: linkMock, getDocumentGroupStatus: groupStatus }));
vi.mock("../../services/email/graphSendService.js", () => ({ sendViaGraph: sendMock }));
vi.mock("../../signnow/finalizeSignedApplication.js", () => ({ finalizeSignedApplication: vi.fn(async () => undefined) }));
vi.mock("../../signnow/pnwSigning.js", () => ({ attachSignedPnwDocument: vi.fn(async () => ({ attached: false })) }));
vi.mock("../../signnow/sba/sbaSigning.js", () => ({ attachSignedSbaDocuments: vi.fn(async () => ({ attached: 0 })), sbaCombinedApplicationDocIfAllSigned: vi.fn(async () => null) }));
vi.mock("../../services/signnow/sendOfferTermSheet.js", () => ({ attachSignedTermSheet: vi.fn(async () => ({ attached: false })) }));
vi.mock("../../modules/applications/applications.service.js", () => ({ transitionPipelineState: vi.fn(async () => undefined) }));
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: vi.fn(async () => undefined) }));
vi.mock("../../services/feeAgreement/mediaFeeAgreement.js", () => ({ confirmFeeAgreementBySignNowIds: vi.fn(async () => ({ matched: false })) }));

import signnowRoutes from "../signnow.js";

const APP = "app-107";
const GROUP = "group-107";
const QUEUE = [
  { index: 2, email: "two@x.com", name: "Owner Two" },
  { index: 4, email: "four@x.com", name: "Owner Four" },
  { index: 3, email: "three@x.com", name: "Owner Three" },
  { index: 5, email: "  ", name: "No Email" },
];

function db(sent: number[] = [], extra: SqlRule[] = []) {
  dbQuery.mockImplementation(answerBySql([
    ...extra,
    [/select id, contact_id from applications where signnow_document_id/, { rows: [{ id: APP, contact_id: null }] }],
    [/metadata->'owner_invite_queue' as queue/, { rows: [{ queue: QUEUE, gid: GROUP, iid: "invite-1", sent }] }],
  ]));
}
const signerEvent = () => postSignnowWebhook(signnowWebhookApp(signnowRoutes), { event: "user.document.fieldinvite.signed", document_group_id: GROUP });
const markSent = () => callsMatching(dbQuery, /jsonb_build_object\('owner_invite_sent'/);

beforeEach(() => {
  dbQuery.mockReset();
  linkMock.mockReset();
  linkMock.mockImplementation(async (_g: string, _i: string, email: string) => ({ url: `https://sign.test/${email}`, expiresAt: null }));
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true });
  groupStatus.mockReset();
  groupStatus.mockResolvedValue({ signed: false, summary: "pending" });
  db();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("owner invite queue", () => {
  it("reads the roster v106 records", async () => {
    const res = await signerEvent();
    expect(res.status).toBe(200);
    const [q] = callsMatching(dbQuery, /owner_invite_queue/);
    expect(q![1]).toEqual([APP]);
  });

  it("starts at Owner 3 so Owner 2 is not double-sent", async () => {
    await signerEvent();
    const emailed = linkMock.mock.calls.map((c) => c[2]);
    expect(emailed).not.toContain("two@x.com");
    expect(emailed).toEqual(["three@x.com"]);
  });

  it("sends to the earliest unsent owner, one per signer event", async () => {
    db([3]);
    await signerEvent();
    expect(linkMock.mock.calls.map((c) => c[2])).toEqual(["four@x.com"]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0]).toMatchObject({ to: "four@x.com", subject: "Your Boreal application is ready to sign" });
    expect(sendMock.mock.calls[0]![0].bodyHtml).toContain("https://sign.test/four@x.com");
    expect(markSent()[0]![1]).toEqual([APP, 4]);
  });

  it("only records an owner as sent when the email actually went", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockResolvedValue({ ok: false, error: "mailbox unavailable" });
    await signerEvent();
    expect(markSent()).toHaveLength(0);
    const [err] = callsMatching(dbQuery, /'owner_invite_error'/);
    expect(err![1]).toEqual([APP, "Owner 3: mailbox unavailable"]);
  });

  it("treats an unreachable step as expected, not as an error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    linkMock.mockRejectedValue(new Error("400 19019002"));
    const res = await signerEvent();
    expect(res.status).toBe(200);
    expect(log.mock.calls.some((c) => String(c[0]).includes("Owner 3 step not reachable yet"))).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(markSent()).toHaveLength(0);
  });

  it("never breaks the webhook ack", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db([], [[/owner_invite_queue/, new Error("db down")]]);
    const res = await signerEvent();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, waiting_for_other_signers: true });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("owner invite queue walk failed: db down"))).toBe(true);
  });
});
