"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetMountedRoutes = resetMountedRoutes;
exports.mount = mount;
const mounted = new Set();
function resetMountedRoutes() {
    mounted.clear();
}
function mount(router, path, handler) {
    if (mounted.has(path)) {
        throw new Error(`ROUTE COLLISION: ${path} already mounted`);
    }
    mounted.add(path);
    router.use(path, handler);
}
