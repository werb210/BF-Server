import { vi } from "vitest";

vi.mock("openai", () => {
  const OpenAI = vi.fn().mockImplementation(() => ({
    models: { list: vi.fn().mockResolvedValue({ data: [] }) },
  }));

  return { default: OpenAI };
});

vi.mock("twilio", () => {
  class MockAccessToken {
    identity: string;

    constructor(_accountSid: string, _apiKey: string, _apiSecret: string, options: { identity: string }) {
      this.identity = options.identity;
    }

    static VoiceGrant = class {
      constructor(_options: { outgoingApplicationSid: string; incomingAllow: boolean }) {}
    };

    addGrant(_grant: unknown) {}

    toJwt() {
      return `mock-jwt-${this.identity}`;
    }
  }

  const twilioFactory = Object.assign(
    vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({ sid: "SM_test" }),
      },
      api: {
        accounts: vi.fn(() => ({ fetch: vi.fn().mockResolvedValue({}) })),
      },
  })),
    {
      jwt: {
        AccessToken: MockAccessToken,
      },
    }
  );

  return { default: twilioFactory, jwt: { AccessToken: MockAccessToken } };
});

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  }));

  return { default: Redis };
});
