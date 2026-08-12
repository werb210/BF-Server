// BF_SERVER_ONE_POOL_v45 - was a separate Pool with no ssl and no keepAlive.
import { pool } from "../db.prod.js";

export const dbClient = pool;

export default dbClient;
