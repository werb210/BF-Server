import 'dotenv/config';

import cookieParser from "cookie-parser";
import cors from "cors";
import express from 'express';
import http from 'http';
import { env } from './config';

const app = express();

// Core middleware
app.use(
  cors({
    origin: [
      "https://staff.boreal.financial",
      "http://localhost:5173",
    ],
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());

// Root (Azure health probe hits this)
app.get('/', (_req, res) => {
  res.status(200).send('ok');
});

// Explicit health endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 🔴 CRITICAL: Azure requires process.env.PORT
const port = Number(process.env.PORT) || env.PORT || 4000;

// Hard visibility into runtime state
console.log('BOOT: START');
console.log('PORT CHECK', {
  processEnv: process.env.PORT,
  parsedEnv: env.PORT,
  finalPort: port,
});

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`BOOT: LISTENING ON ${port}`);
});

// Crash hard — never silent fail
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
  process.exit(1);
});
