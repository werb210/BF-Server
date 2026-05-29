import { describe, it, expect } from "vitest";
import { normalizePhone } from "../auth/otpService.js";

describe("v667 OTP phone normalization (duplicate leading 1)", () => {
  it("10-digit national -> +1XXXXXXXXXX", () => {
    expect(normalizePhone("8254511768")).toBe("+18254511768");
  });
  it("11-digit with one country code -> unchanged canonical", () => {
    expect(normalizePhone("18254511768")).toBe("+18254511768");
  });
  it("THE BUG: extra leading 1 (12 digits) collapses, not +11...", () => {
    expect(normalizePhone("118254511768")).toBe("+18254511768");
  });
  it("formatted input with stray duplicate +1 collapses", () => {
    expect(normalizePhone("+1 1 (825) 451-1768")).toBe("+18254511768");
  });
  it("multiple stray leading 1s all collapse", () => {
    expect(normalizePhone("1118254511768")).toBe("+18254511768");
  });
  it("too-short input still throws", () => {
    expect(() => normalizePhone("12345")).toThrow();
  });
});
