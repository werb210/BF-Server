import app from './app/app';
import { initDb } from './db/init';

const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
}

start();
