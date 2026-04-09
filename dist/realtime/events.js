import { EventEmitter } from "events";
export const realtimeEvents = new EventEmitter();
export function emitAiEscalation(event) {
    realtimeEvents.emit("ai:escalated", event);
}
