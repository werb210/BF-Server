import { optionalString, requireString } from "../../system/validate";

describe("system/validate", () => {
  it("throws INVALID_* with status 400 for invalid required strings", () => {
    const assertInvalid = (value: unknown) => {
      try {
        requireString(value, "EMAIL");
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("INVALID_EMAIL");
        expect(err.status).toBe(400);
      }
    };

    assertInvalid(undefined);
    assertInvalid(null);
    assertInvalid(42);
    assertInvalid("   ");
  });

  it("returns trimmed value for valid required strings", () => {
    expect(requireString("  hello@example.com  ", "EMAIL")).toBe("hello@example.com");
  });

  it("returns undefined for non-string optional values and trims strings", () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString(123)).toBeUndefined();
    expect(optionalString("  hi  ")).toBe("hi");
  });
});
