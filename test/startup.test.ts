import { describe, expect, it, vi, beforeEach } from "vitest";

const connectMock = vi.fn(async () => undefined);
const pingMock = vi.fn(async () => "PONG");

vi.mock("../src/infra/db", () => ({
  prisma: {
    $connect: connectMock,
  },
}));

vi.mock("../src/infra/redis", () => ({
  redis: {
    connect: vi.fn(async () => undefined),
    ping: pingMock,
  },
}));

describe("bootstrap", () => {
  beforeEach(() => {
    connectMock.mockClear();
    pingMock.mockClear();
  });

  it("connects prisma", async () => {
    const { bootstrap } = await import("../src/startup/bootstrap");
    await bootstrap();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
