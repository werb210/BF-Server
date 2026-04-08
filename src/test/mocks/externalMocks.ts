import { vi } from "vitest";

vi.mock("openai", () => {
  const OpenAI = vi.fn().mockImplementation(() => ({
    models: { list: vi.fn().mockResolvedValue({ data: [] }) },
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
  })),
}));

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  }));

  return { default: Redis };
});
