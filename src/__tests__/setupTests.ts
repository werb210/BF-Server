jest.mock("../brain/openaiClient", () => ({
  __esModule: true,
  runAI: jest.fn(),
}));

jest.mock("../db", () => {
  const mockRequest = jest.fn(() => ({
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockResolvedValue({ recordset: [] }),
  }));

  return {
    __esModule: true,
    default: {
      pool: {
        request: mockRequest,
      },
    },
    pool: {
      request: mockRequest,
    },
  };
});
