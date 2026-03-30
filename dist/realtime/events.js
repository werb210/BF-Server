"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.realtimeEvents = void 0;
exports.emitAiEscalation = emitAiEscalation;
const events_1 = require("events");
exports.realtimeEvents = new events_1.EventEmitter();
function emitAiEscalation(event) {
    exports.realtimeEvents.emit("ai:escalated", event);
}
