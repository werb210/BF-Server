const listeners = {};
export const eventBus = {
    emit(event, payload) {
        if (!listeners[event])
            return;
        for (const h of listeners[event])
            h(payload);
    },
    on(event, handler) {
        if (!listeners[event])
            listeners[event] = [];
        listeners[event].push(handler);
    },
};
export function emit(event, payload) {
    eventBus.emit(event, payload);
}
export function on(event, handler) {
    eventBus.on(event, handler);
}
