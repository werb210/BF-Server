export const google = {
  auth: {
    GoogleAuth: vi.fn().mockImplementation(() => ({})),
  },
  sheets: vi.fn(() => ({
    spreadsheets: {
      get: vi.fn(),
      values: {
        get: vi.fn(),
        append: vi.fn(),
      },
    },
  })),
};
