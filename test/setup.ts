import { jest } from "@jest/globals";

jest.mock("../src/brain/openaiClient", () => require("./mocks/openaiClientMock"));

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

beforeEach(() => {
  const { runAI } = require("./mocks/openaiClientMock");
  runAI.mockReset();
});
