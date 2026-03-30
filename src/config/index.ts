import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().optional(),

  OPENAI_API_KEY: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('ENV VALIDATION FAILED');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export const config: typeof env = env;
export const ENV: typeof env = env;

export function assertEnv(): void {
  // Environment is validated at module load.
}
