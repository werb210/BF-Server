import { getPrisma } from "../infra/db.js";
import { getRedis } from "../infra/redis.js";
import { config } from "../config/index.js";
export async function bootstrap() {
    await getPrisma();
    const redis = getRedis();
    if (config.redis.url && config.env !== "test" && redis) {
        try {
            await redis.ping();
        }
        catch {
            console.warn("Redis unavailable — continuing");
        }
    }
}
