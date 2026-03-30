"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
console.log('BOOT: start');
(async () => {
    try {
        console.log('BOOT: loading express');
        const express = (await import('express')).default;
        const app = express();
        // MUST BE FIRST AND IMMEDIATE
        app.get('/health', (_req, res) => {
            res.status(200).send('OK');
        });
        const port = Number(process.env.PORT) || 8080;
        console.log('BOOT: starting listen');
        app.listen(port, '0.0.0.0', () => {
            console.log(`BOOT: listening on ${port}`);
        });
        // LOAD EVERYTHING ELSE AFTER SERVER IS LIVE
        setImmediate(async () => {
            try {
                console.log('BOOT: loading server module');
                const { createServer } = await import('./server/createServer.js');
                const router = await createServer();
                app.use(router);
                console.log('BOOT: server mounted');
            }
            catch (err) {
                console.error('BOOT: server load failed', err);
            }
        });
    }
    catch (err) {
        console.error('BOOT: fatal startup failure', err);
    }
})();
