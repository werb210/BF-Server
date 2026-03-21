import { app } from './app';

const port = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Server listening on ${port}`);
  });
}
