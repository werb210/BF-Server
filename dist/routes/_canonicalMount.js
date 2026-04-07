"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mount = mount;
const mounted = new Set();
function mount(router, path, handler) {
    if (mounted.has(path)) {
        console.warn(`ROUTE COLLISION (ignored in test): ${path}`);
        return;
    }
    mounted.add(path);
    router.use(path, handler);
}
