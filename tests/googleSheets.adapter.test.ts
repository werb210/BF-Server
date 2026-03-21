import { GoogleSheetSubmissionAdapter } from "../src/modules/submissions/adapters/GoogleSheetSubmissionAdapter";
import { vi } from "vitest";

const sheetsInstance = {
  spreadsheets: {
    get: vi.fn(),
    values: {
      get: vi.fn(),
      append: vi.fn(),
    },
  },
};

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: vi.fn().mockImplementation(() => ({})),
    },
    sheets: vi.fn(() => sheetsInstance),
  },
}));

const payload = {
  application: {
    id: "app-123",
    ownerUserId: null,
    name: "Test Application",
    metadata: {
      applicant: {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "+15555550123",
      },
    },
    productType: "standard",
    lenderId: "lender-1",
    lenderProductId: "product-1",
    requestedAmount: 25000,
  },
  documents: [],
  submittedAt: "2024-01-02T00:00:00.000Z",
};

const config = {
  spreadsheetId: "sheet-123",
  sheetName: "Sheet1",
  columnMapVersion: "v1",
};

describe("google sheet submission adapter", () => {
  beforeAll(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "service@example.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends a new row when the application is not present", async () => {
    sheetsInstance.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Sheet1" } }] },
    });
    sheetsInstance.spreadsheets.values.get
      .mockResolvedValueOnce({
        data: {
          values: [
            [
              "Application ID",
              "Submitted At",
              "Applicant First Name",
              "Applicant Last Name",
              "Requested Amount",
              "Product Type",
            ],
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { values: [["Application ID"], ["other-app"]] },
      });
    sheetsInstance.spreadsheets.values.append.mockResolvedValue({
      data: { updates: { updatedRange: "Sheet1!A2:F2" } },
    });

    const adapter = new GoogleSheetSubmissionAdapter({ payload, config });
    const result = await adapter.submit(payload);

    expect(result.success).toBe(true);
    expect(result.response.status).toBe("appended");
    expect(result.response.externalReference).toBe("2");
    expect(sheetsInstance.spreadsheets.values.append).toHaveBeenCalledTimes(1);
  });

  it("fails when columnMapVersion is missing", async () => {
    sheetsInstance.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Sheet1" } }] },
    });

    const adapter = new GoogleSheetSubmissionAdapter({
      payload,
      config: { spreadsheetId: "sheet-123", sheetName: "Sheet1", columnMapVersion: "" },
    });
    const result = await adapter.submit(payload);

    expect(result.success).toBe(false);
    expect(result.response.detail).toBe("Google Sheet columnMapVersion is invalid.");
  });

  it("skips append when the application already exists", async () => {
    sheetsInstance.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: { title: "Sheet1" } }] },
    });
    sheetsInstance.spreadsheets.values.get
      .mockResolvedValueOnce({
        data: {
          values: [
            [
              "Application ID",
              "Submitted At",
              "Applicant First Name",
              "Applicant Last Name",
              "Requested Amount",
              "Product Type",
            ],
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { values: [["Application ID"], ["app-123"]] },
      });

    const adapter = new GoogleSheetSubmissionAdapter({ payload, config });
    const result = await adapter.submit(payload);

    expect(result.success).toBe(true);
    expect(result.response.status).toBe("duplicate");
    expect(result.response.externalReference).toBe("2");
    expect(sheetsInstance.spreadsheets.values.append).not.toHaveBeenCalled();
  });

  it("handles permission errors from the Google API", async () => {
    sheetsInstance.spreadsheets.get.mockRejectedValue({ response: { status: 403 } });

    const adapter = new GoogleSheetSubmissionAdapter({ payload, config });
    const result = await adapter.submit(payload);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });
});
