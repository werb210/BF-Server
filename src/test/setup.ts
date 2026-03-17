import { vi } from "vitest";

vi.mock("twilio", () => {
  return {
    default: function () {
      return {
        messages: {
          create: vi.fn().mockResolvedValue({
            sid: "test_sid"
          })
        }
      };
    }
  };
});
