"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBus = void 0;
exports.emit = emit;
exports.on = on;
const listeners = {};
exports.eventBus = {
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
function emit(event, payload) {
    exports.eventBus.emit(event, payload);
}
function on(event, handler) {
    exports.eventBus.on(event, handler);
}
