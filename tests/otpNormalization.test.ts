import { normalizePhone } from "../src/utils/phone";

describe("phone normalization", () => {
  test("normalizes canadian number", () => {
    expect(normalizePhone("4035551234")).toBe("+14035551234");
  });

  test("accepts + format", () => {
    expect(normalizePhone("+14035551234")).toBe("+14035551234");
  });

  test("rejects invalid numbers", () => {
    expect(() => normalizePhone("555")).toThrow("Invalid phone number format");
  });
});
