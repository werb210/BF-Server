import { createApp } from "./app";
import { getEnv } from "./config/env";
import { deps } from "./system/deps";

export const app = createApp(deps);

if (require.main === module) {
  const { PORT } = getEnv();

  app.listen(Number(PORT || 8080), () => {
    console.log(`Server running on ${PORT || 8080}`);
  });
}

export default app;
