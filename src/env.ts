export function assertEnv() {
  if (!process.env.JWT_SECRET) {
    throw new Error('Missing JWT_SECRET');
  }

  if (!process.env.PORT) {
    throw new Error('Missing PORT');
  }
}
