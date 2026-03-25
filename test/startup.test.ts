
const connectMock = jest.fn(async () => undefined);
const pingMock = jest.fn(async () => "PONG");

jest.mock("../src/infra/db", () => ({
  prisma: {
    $connect: connectMock,
  },
}));

jest.mock("../src/infra/redis", () => ({
  redis: {
    connect: jest.fn(async () => undefined),
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
