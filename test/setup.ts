import { jest } from "@jest/globals";

jest.mock("../src/brain/openaiClient", () => ({
  __esModule: true,
  runAI: jest.fn(),
}));

jest.mock("../src/db", () => {
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
