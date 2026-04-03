import { ApiResponseSchema } from "../contracts";

test("response contract stays valid", () => {
  const sample = {
    status: "ok",
    data: {},
  };

  expect(ApiResponseSchema.safeParse(sample).success).toBe(true);
});
