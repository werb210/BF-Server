console.log('BOOT: start');

(async () => {
  const express = (await import('express')).default;

  const app = express();

  // MUST RESPOND IMMEDIATELY — DO NOT TOUCH THIS
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  const port = Number(process.env.PORT) || 8080;

  console.log('BOOT: starting listen');

  app.listen(port, '0.0.0.0', () => {
    console.log(`BOOT: listening on ${port}`);
  });

  // LOAD REAL SERVER AFTER
  setImmediate(async () => {
    try {
      console.log('BOOT: loading server');

      const { createServer } = await import('./server/createServer');

      const router = await createServer();

      // CRITICAL: MOUNT AT ROOT
      app.use('/', router);

      console.log('BOOT: server mounted');
    } catch (err) {
      console.error('BOOT: mount failed', err);
    }
  });
})();
