import express from 'express';

const app = express();

// BASIC MIDDLEWARE
app.use(express.json());

// HEALTH CHECK (AZURE NEEDS THIS)
app.get('/health', (req, res) => {
  console.log('HEALTH CHECK HIT');
  res.status(200).send('ok');
});

// ROOT TEST
app.get('/', (req, res) => {
  console.log('ROOT HIT');
  res.send('server alive');
});

// PORT (CRITICAL FOR AZURE)
const PORT = process.env.PORT || 8080;

console.log('Starting server...');
console.log('PORT:', PORT);

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
