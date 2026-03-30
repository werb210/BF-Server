import 'dotenv/config';

import express from 'express';
import http from 'http';
import { env } from './config';

const app = express();

// Core middleware
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Server bootstrap
const port = env.PORT || 4000;

const server = http.createServer(app);

server.listen(port, () => {
  console.log('BOOT: START');
  console.log(`BOOT: LISTENING ON ${port}`);
});

// Hard crash handling (required in production)
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
  process.exit(1);
});
