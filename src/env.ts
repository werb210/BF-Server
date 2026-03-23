import dotenv from 'dotenv';
import { config } from './config';

dotenv.config();

console.log('[ENV] NODE_ENV:', config.env);
