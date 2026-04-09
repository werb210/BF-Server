import { ApiResponseSchema } from "../contracts/index.js";

test("response contract stays valid", () => {
  const sample = {
    status: "ok",
    data: {},
  };

  expect(ApiResponseSchema.safeParse(sample).success).toBe(true);
});
