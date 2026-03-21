import { SubmissionRouter } from "../src/modules/submissions/SubmissionRouter";

const submitMock = vi.fn();

vi.mock("../src/modules/submissions/adapters/GoogleSheetSubmissionAdapter", () => ({
  GoogleSheetSubmissionAdapter: vi.fn().mockImplementation(() => ({
    submit: submitMock,
  })),
}));

const payload = {
  application: {
    id: "app-123",
    ownerUserId: null,
    name: "Test Application",
    metadata: {},
    productType: "standard",
    lenderId: "lender-1",
    lenderProductId: "product-1",
    requestedAmount: 1000,
  },
  documents: [],
  submittedAt: "2024-01-02T00:00:00.000Z",
};

describe("SubmissionRouter", () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue({
      success: true,
      response: { status: "ok", receivedAt: new Date().toISOString() },
      failureReason: null,
      retryable: false,
    });
  });

  it("selects the Google Sheet adapter for google_sheet methods", async () => {
    const router = new SubmissionRouter({
      profile: {
        lenderId: "lender-1",
        lenderName: "Test Lender",
        submissionMethod: "google_sheet",
        submissionEmail: null,
        submissionConfig: {
          spreadsheetId: "sheet-1",
          sheetName: "Sheet1",
          columnMapVersion: "v1",
        },
      },
      payload,
      attempt: 0,
    });

    const result = await router.submit();

    expect(result.success).toBe(true);
    expect(submitMock).toHaveBeenCalledWith(payload);
  });
});
