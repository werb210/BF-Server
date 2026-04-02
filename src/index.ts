import { createApp } from "./app";
import { deps } from "./system/deps";

export const app = createApp(deps);

if (require.main === module) {
  const PORT = process.env.PORT || 8080;

  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
  });
}

export default app;
