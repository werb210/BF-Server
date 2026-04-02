import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
});

let cached: z.infer<typeof schema> | null = null;

export function getEnv() {
  if (!cached) {
    cached = schema.parse(process.env);
  }
  return cached;
}
