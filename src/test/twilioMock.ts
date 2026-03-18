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

class AccessTokenMock {
  private identity?: string;
  private ttl?: number;

  constructor(
    _accountSid: string,
    _apiKey: string,
    _apiSecret: string,
    opts?: { identity?: string; ttl?: number }
  ) {
    this.identity = opts?.identity;
    this.ttl = opts?.ttl;
  }

  addGrant(_grant: unknown): void {}

  toJwt(): string {
    const identity = this.identity ?? "anonymous";
    const ttl = this.ttl ?? 0;
    return `voice-token-${identity}-${ttl}`;
  }

  static VoiceGrant = class {
    outgoingApplicationSid: string;

    constructor(opts: { outgoingApplicationSid: string }) {
      this.outgoingApplicationSid = opts.outgoingApplicationSid;
    }
  };
}

const createVerification = vi.fn(async () => ({ sid: "VE_TEST", status: "pending" }));
const createVerificationCheck = vi.fn(async () => ({ sid: "VC_TEST", status: "approved" }));
const createCall = vi.fn(async () => ({ sid: "CA123", status: "queued" }));
const updateCall = vi.fn(async (callSid?: string, params?: { status?: string }) => ({
  sid: callSid ?? "CA123",
  status: params?.status ?? "in-progress",
}));

const calls = Object.assign(
  (callSid?: string) => ({ update: (params: { status?: string; twiml?: string }) => updateCall(callSid, params) }),
  { create: createCall }
);

const services = vi.fn((serviceSid: string) => {
  twilioMockState.lastServiceSid = serviceSid;
  return {
    verifications: { create: createVerification },
    verificationChecks: { create: createVerificationCheck },
  };
});

export class Twilio {
  constructor() {}
  messages = {
    create: async () => ({ sid: "mock_sid" }),
  };
  verify = { v2: { services } };
  calls = calls;
}

const twilioConstructor = vi.fn(function TwilioConstructor() {
  return new Twilio();
});

function normalizeParams(params: TwilioParams): string {
  return Object.keys(params).sort().map((key) => `${key}:${String(params[key])}`).join("|");
}

function getExpectedTwilioSignature(authToken: string, url: string, params: TwilioParams): string {
  return `${authToken}|${url}|${normalizeParams(params)}`;
}

function validateRequest(authToken: string, signature: string, url: string, params: TwilioParams): boolean {
  if (!authToken || !signature) return false;
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

const twilioMockState = {
  createVerification,
  createVerificationCheck,
  createCall,
  updateCall,
  twilioConstructor,
  services,
  lastServiceSid: null as string | null,
};

const twilioDefaultExport = Object.assign(twilioConstructor, {
  twiml: { VoiceResponse: VoiceResponseMock },
  jwt: { AccessToken: AccessTokenMock },
  __twilioMocks: twilioMockState,
});

export { getExpectedTwilioSignature, twilioDefaultExport, twilioMockState, validateExpressRequest, validateRequest, VoiceResponseMock };
