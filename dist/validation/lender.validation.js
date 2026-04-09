import { z } from "zod";
export const createLenderSchema = z.object({
    name: z.string().min(1),
});
