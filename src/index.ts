process.on("unhandledRejection", e => console.error("REJECTION", e));
process.on("uncaughtException", e => console.error("UNCAUGHT", e));
import { buildApp } from './app';

const app = buildApp();

const PORT = process.env.PORT || 8080;

console.log('BOOTING REAL SERVER...');
console.log('PORT:', PORT);

app.listen(PORT, () => {
  console.log(`REAL SERVER RUNNING ON ${PORT}`);
});

// --- SYSTEM CONTRACT: GLOBAL ERROR HANDLING ---
import { notFoundHandler } from './middleware/notFoundHandler';
import { errorHandler } from './middleware/errorHandler';

app.use(notFoundHandler);
app.use(errorHandler);
