function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

export function validateEnv(): void {
  required("JWT_SECRET");
}

export const config = {
  JWT_SECRET: required("JWT_SECRET"),
};
