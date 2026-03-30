"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
console.log('BOOT: start');
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION:', err);
    process.exit(1);
});
const createServer_1 = require("./server/createServer");
const env_1 = require("./env");
const runtimeGuards_1 = require("./server/runtimeGuards");
async function boot() {
    try {
        console.log('BOOT: env check');
        (0, env_1.assertEnv)();
        console.log('BOOT: guard check');
        (0, runtimeGuards_1.assertSingleServerStart)();
        console.log('BOOT: creating server');
        const app = (0, createServer_1.createServer)();
        const port = process.env.PORT || 8080;
        console.log('BOOT: starting listen');
        const startTimeout = setTimeout(() => {
            console.error('BOOT TIMEOUT: server failed to start in 30s');
            process.exit(1);
        }, 30000);
        const server = app.listen(port, () => {
            console.log(`BOOT: listening on ${port}`);
            clearTimeout(startTimeout);
        });
        server.setTimeout(30000);
    }
    catch (err) {
        console.error('BOOT FAILED:', err);
        process.exit(1);
    }
}
boot();
