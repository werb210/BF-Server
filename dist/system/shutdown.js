import { pool } from "../db.js";
export function setupShutdown(server) {
    const shutdown = async () => {
        console.log("[SHUTDOWN] closing");
        try {
            await pool.end();
        }
        catch {
            // noop
        }
        server.close(() => {
            console.log("[SHUTDOWN] server closed");
        });
        setTimeout(() => {
            throw new Error("Forced shutdown timeout exceeded");
        }, 10000);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
