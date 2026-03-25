import { z } from "zod";

export const TelephonyToken = {
  response: z.object({
    ok: z.literal(true),
    data: z.object({
      token: z.string(),
    }),
  }),
};
