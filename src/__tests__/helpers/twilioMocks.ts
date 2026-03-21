import { vi, type MockedFunction } from 'vitest';
import type {
  VerificationInstance,
  VerificationListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verification";
import type {
  VerificationCheckInstance,
  VerificationCheckListInstanceCreateOptions,
} from "twilio/lib/rest/verify/v2/service/verificationCheck";
import type { ClientOpts } from "twilio/lib/base/BaseTwilio";

type VerificationCreateMock = MockedFunction<
  (
    params: VerificationListInstanceCreateOptions
  ) => Promise<Pick<VerificationInstance, "sid" | "status">>
>;

type VerificationCheckCreateMock = MockedFunction<
  (
    params: VerificationCheckListInstanceCreateOptions
  ) => Promise<Pick<VerificationCheckInstance, "status" | "sid">>
>;

type TwilioConstructorMock = MockedFunction<
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

type ServicesMock = MockedFunction<
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
  createCall: MockedFunction<
    (params: { to: string; from: string; applicationSid: string }) => Promise<{ sid: string; status: string }>
  >;
  updateCall: MockedFunction<
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
