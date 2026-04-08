import { vi } from "vitest";

vi.mock("openai", () => {
  const OpenAI = vi.fn().mockImplementation(() => ({
    models: { list: vi.fn().mockResolvedValue({ data: [] }) },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "mocked" } }],
        }),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] }),
    },
  }));

  return { default: OpenAI };
});

vi.mock("twilio", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({ sid: "SM_test" }),
    },
    api: {
      accounts: vi.fn(() => ({ fetch: vi.fn().mockResolvedValue({}) })),
    },
    verify: {
      v2: {
        services: vi.fn(() => ({
          verifications: { create: vi.fn().mockResolvedValue({ sid: "VE_test", status: "pending" }) },
          verificationChecks: { create: vi.fn().mockResolvedValue({ sid: "VC_test", status: "approved" }) },
        })),
      },
    },
  })),
}));

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue("PONG"),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
    quit: vi.fn().mockResolvedValue("OK"),
  }));

  return { default: Redis };
});

const mockFetch = vi.fn(() => {
  throw new Error("Real network call blocked in test");
});

const blockedFetch = new Proxy(mockFetch as unknown as typeof global.fetch, {
  apply() {
    throw new Error("NETWORK_CALL_BLOCKED");
  },
});

Object.defineProperty(global, "fetch", {
  configurable: false,
  writable: false,
  value: blockedFetch,
});
