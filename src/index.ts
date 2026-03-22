import { createApp } from './app';

const app = createApp();

const PORT = process.env.PORT || 8080;

console.log('BOOTING REAL SERVER...');
console.log('PORT:', PORT);

app.listen(PORT, () => {
  console.log(`REAL SERVER RUNNING ON ${PORT}`);
});
