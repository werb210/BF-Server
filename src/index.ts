import express, { Request, Response } from 'express';

const app = express();

app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  console.log('HEALTH CHECK HIT');
  res.status(200).send('ok');
});

app.get('/', (req: Request, res: Response) => {
  console.log('ROOT HIT');
  res.send('server alive');
});

const PORT = process.env.PORT || 8080;

console.log('Starting server...');
console.log('PORT:', PORT);

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
