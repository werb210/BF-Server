import { describe, it, expect } from "vitest";
import { parseAmount } from "../bankingFromOcr.js";

describe("parseAmount trailing-minus (Canadian/TD overdraft)", () => {
  it("treats a trailing minus as negative", () => {
    expect(parseAmount("24,908.00-")).toBe(-24908);
    expect(parseAmount("$1,234.56-")).toBe(-1234.56);
  });
  it("still handles leading minus and parentheses", () => {
    expect(parseAmount("-500.00")).toBe(-500);
    expect(parseAmount("(2,000.00)")).toBe(-2000);
  });
  it("leaves positive values positive", () => {
    expect(parseAmount("46,577.72")).toBe(46577.72);
    expect(parseAmount("$92,345.00")).toBe(92345);
  });
});
