import cors from 'cors';

const allowed = [
  'https://boreal.financial',
  'https://www.boreal.financial',
  'https://client.boreal.financial',
  'https://staff.boreal.financial',
];

export const corsMiddleware = cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowed.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
});
