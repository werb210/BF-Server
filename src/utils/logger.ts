export const logger = {
  info: (message: string, meta?: unknown) => {
    console.info(message, meta ?? "");
  },
  error: (message: string, meta?: unknown) => {
    console.error(message, meta ?? "");
  },
};
