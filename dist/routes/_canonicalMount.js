const mounted = new Set();
export function resetMountedRoutes() {
    mounted.clear();
}
export function mount(router, path, handler) {
    if (mounted.has(path)) {
        throw new Error(`ROUTE COLLISION: ${path} already mounted`);
    }
    mounted.add(path);
    router.use(path, handler);
}
