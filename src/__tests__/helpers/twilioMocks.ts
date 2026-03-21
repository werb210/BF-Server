import type {
  VerificationInstance,
  VerificationListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verification";
import type {
  VerificationCheckInstance,
  VerificationCheckListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verificationCheck";
import type { ClientOpts } from "twilio/lib/base/BaseTwilio";

type VerificationCreateMock = vi.MockedFunction<
  (
    params: VerificationListInstanceCreateOptions
  ) => Promise<Pick<VerificationInstance, "sid" | "status">>
>;

type VerificationCheckCreateMock = vi.MockedFunction<
  (
    params: VerificationCheckListInstanceCreateOptions
  ) => Promise<Pick<VerificationCheckInstance, "status" | "sid">>
>;

type TwilioConstructorMock = vi.MockedFunction<
  (
    accountSid?: string,
    authToken?: string,
    opts?: ClientOpts
  ) => {
    verify: {
      v2: {
        services: ServicesMock;
      };
    };
  }
>;

type ServicesMock = vi.MockedFunction<
  (serviceSid: string) => {
    verifications: {
      create: VerificationCreateMock;
    };
    verificationChecks: {
      create: VerificationCheckCreateMock;
    };
  }
>;

export type TwilioMockState = {
  createVerification: VerificationCreateMock;
  createVerificationCheck: VerificationCheckCreateMock;
  createCall: vi.MockedFunction<
    (params: { to: string; from: string; applicationSid: string }) => Promise<{ sid: string; status: string }>
  >;
  updateCall: vi.MockedFunction<
    (callSid?: string, params?: { status?: string; twiml?: string }) => Promise<{ sid: string; status: string }>
  >;
  twilioConstructor: TwilioConstructorMock;
  services: ServicesMock;
  lastServiceSid: string | null;
};

type GlobalWithTwilioMocks = typeof globalThis & {
  __twilioMocks?: TwilioMockState;
};

export function getTwilioMocks(): TwilioMockState {
  const globalWithMocks = globalThis as GlobalWithTwilioMocks;
  if (!globalWithMocks.__twilioMocks) {
    throw new Error("Twilio mocks not initialized.");
  }
  return globalWithMocks.__twilioMocks;
}
