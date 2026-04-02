import { createApp } from "./app";
import { getEnv } from "./config/env";

export const app = createApp();

if (require.main === module) {
  const { PORT } = getEnv();

  app.listen(Number(PORT || 8080), () => {
    console.log(`Server running on ${PORT || 8080}`);
  });
}

export default app;
