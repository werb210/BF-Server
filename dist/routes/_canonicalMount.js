"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mount = mount;
const mounted = new Set();
function mount(router, path, handler) {
    if (mounted.has(path)) {
        console.error(`ROUTE COLLISION: ${path} already mounted`);
        process.exit(1);
    }
    mounted.add(path);
    router.use(path, handler);
}
