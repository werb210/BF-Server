import type { ClientOpts } from "twilio/lib/base/BaseTwilio";
import type {
  VerificationInstance,
  VerificationListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verification";
import type {
  VerificationCheckInstance,
  VerificationCheckListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verificationCheck";

const createVerification = vi.fn<
  Promise<Pick<VerificationInstance, "sid" | "status">>,
  [VerificationListInstanceCreateOptions]
>(async () => ({ sid: "VE123", status: "pending" }));

const createVerificationCheck = vi.fn<
  Promise<Pick<VerificationCheckInstance, "status" | "sid">>,
  [VerificationCheckListInstanceCreateOptions]
>(async () => ({ status: "approved", sid: "VEXXXXX" }));

type VerificationService = {
  verifications: {
    create: typeof createVerification;
  };
  verificationChecks: {
    create: typeof createVerificationCheck;
  };
};

type ServicesMock = vi.MockedFunction<
  (serviceSid: string) => VerificationService
>;

type TwilioClientMock = {
  verify: {
    v2: {
      services: ServicesMock;
    };
  };
  calls: typeof calls;
};

const mockService: VerificationService = {
  verifications: { create: createVerification },
  verificationChecks: { create: createVerificationCheck },
};

const twilioMockState = {
  createVerification,
  createVerificationCheck,
  lastServiceSid: null as string | null,
};

const createCall = vi.fn(
  async (_params: { to: string; from: string; applicationSid: string }) => ({
    sid: "CA123",
    status: "queued",
  })
);
const updateCall = vi.fn(
  async (_callSid: string | undefined, _params?: { status?: string; twiml?: string }) => ({
    sid: _callSid ?? "CA123",
    status: _params?.status ?? "in-progress",
  })
);

const calls = Object.assign(
  (callSid?: string) => ({
    update: (params: { status?: string; twiml?: string }) => updateCall(callSid, params),
  }),
  { create: createCall }
);

class AccessTokenMock {
  private grants: unknown[] = [];
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

  addGrant(grant: unknown): void {
    this.grants.push(grant);
  }

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

const services: ServicesMock = vi.fn((serviceSid: string) => {
  twilioMockState.lastServiceSid = serviceSid;
  return mockService;
});

const mockClient: TwilioClientMock = {
  verify: {
    v2: {
      services,
    },
  },
  calls,
};

const TwilioMock = vi.fn<
  TwilioClientMock,
  [string | undefined, string | undefined, ClientOpts | undefined]
>(() => mockClient);

const twilioModule = Object.assign(TwilioMock, {
  default: TwilioMock,
  jwt: {
    AccessToken: AccessTokenMock,
  },
  __twilioMocks: {
    ...twilioMockState,
    services,
    twilioConstructor: TwilioMock,
    createCall,
    updateCall,
  },
});

export = twilioModule;
