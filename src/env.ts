export function assertEnv() {
  const required = ['JWT_SECRET', 'PORT'];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing env var: ${key}`);
    }
  }
}
