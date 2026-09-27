import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyBiApplicant } from "../biApplicantMessages.js";

describe("BI applicant in-app message bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BI_SERVER_URL;
    delete process.env.BACKEND_SERVICE_TOKEN;
  });

  it("sends staff replies to BI-Server with service authentication", async () => {
    process.env.BI_SERVER_URL = "https://bi.example.test/";
    process.env.BACKEND_SERVICE_TOKEN = "secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyBiApplicant({ contactId: "contact-1", body: "Hello", messageId: "message-1" }))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bi.example.test/api/v1/bi/applicant-messages/from-bf",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret", "x-silo": "BI" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      contact_id: "contact-1", body: "Hello", message_id: "message-1",
    });
  });

  it("fails closed when the shared service token is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(notifyBiApplicant({ contactId: "contact-1", body: "Hello" }))
      .resolves.toEqual({ ok: false, error: "BACKEND_SERVICE_TOKEN is not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
