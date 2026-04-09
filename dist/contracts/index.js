import { z } from "zod";
export const ApiResponseSchema = z.union([
    z.object({
        status: z.literal("ok"),
        data: z.unknown(),
    }),
    z.object({
        status: z.literal("error"),
        error: z.string(),
    }),
]);
