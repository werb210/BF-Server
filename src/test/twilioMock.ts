import { vi } from "vitest";

type TwilioParams = Record<string, unknown>;

class VoiceResponseMock {
  private readonly actions: string[] = [];

  say(message?: string): this {
    const safeMessage = message ?? "";
    this.actions.push(`<Say>${safeMessage}</Say>`);
    return this;
  }

  dial(): { client: (identity: string) => void } {
    return {
      client: (identity: string) => {
        this.actions.push(`<Dial><Client>${identity}</Client></Dial>`);
      },
    };
  }

  toString(): string {
    return `<Response>${this.actions.join("")}</Response>`;
  }
}

const createVerification = vi.fn(async () => ({ sid: "VE_TEST", status: "pending" }));
const createVerificationCheck = vi.fn(async () => ({ sid: "VC_TEST", status: "approved" }));
const services = vi.fn(() => ({
  verifications: { create: createVerification },
  verificationChecks: { create: createVerificationCheck },
}));

class TwilioMock {
  verify = { v2: { services } };
}

function normalizeParams(params: TwilioParams): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}:${String(params[key])}`)
    .join("|");
}

function getExpectedTwilioSignature(authToken: string, url: string, params: TwilioParams): string {
  return `${authToken}|${url}|${normalizeParams(params)}`;
}

function validateRequest(authToken: string, signature: string, url: string, params: TwilioParams): boolean {
  if (!authToken || !signature) {
    return false;
  }

  return signature === getExpectedTwilioSignature(authToken, url, params);
}

function validateExpressRequest(
  req: { get: (header: string) => string | undefined; body?: TwilioParams },
  authToken: string,
  options?: { url?: string },
): boolean {
  const signature = req.get("X-Twilio-Signature") ?? "";
  const url = options?.url ?? "";
  return validateRequest(authToken, signature, url, req.body ?? {});
}

const twilioDefaultExport = Object.assign(TwilioMock, {
  twiml: {
    VoiceResponse: VoiceResponseMock,
  },
});

export {
  getExpectedTwilioSignature,
  twilioDefaultExport,
  validateExpressRequest,
  validateRequest,
  VoiceResponseMock,
};
