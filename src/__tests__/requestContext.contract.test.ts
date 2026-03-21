import { describe, it, expect } from 'vitest';
import * as ctx from "../middleware/requestContext";

describe("requestContext exports", () => {
  test("expected helpers exist", () => {
    expect(ctx.requestContext).toBeDefined();
    expect(ctx.runWithRequestContext).toBeDefined();
    expect(ctx.getRequestId).toBeDefined();
    expect(ctx.getRequestRoute).toBeDefined();
  });
});
