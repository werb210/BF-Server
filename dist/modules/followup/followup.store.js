"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultFollowUpTaskStore = exports.defaultFollowUpIdempotencyStore = exports.defaultFollowUpEventStore = exports.InMemoryFollowUpTaskStore = exports.InMemoryFollowUpIdempotencyStore = exports.InMemoryFollowUpEventStore = void 0;
exports.recordFollowUpEvent = recordFollowUpEvent;
const crypto_1 = require("crypto");
class InMemoryFollowUpEventStore {
    events = [];
    addEvent(event) {
        this.events.push(event);
    }
    listEvents(filter) {
        if (!filter) {
            return [...this.events];
        }
        return this.events.filter((event) => {
            if (filter.type && event.type !== filter.type) {
                return false;
            }
            if (filter.entityType && event.entityType !== filter.entityType) {
                return false;
            }
            if (filter.entityId && event.entityId !== filter.entityId) {
                return false;
            }
            return true;
        });
    }
}
exports.InMemoryFollowUpEventStore = InMemoryFollowUpEventStore;
class InMemoryFollowUpIdempotencyStore {
    processed = new Set();
    has(key) {
        return this.processed.has(key);
    }
    mark(key) {
        this.processed.add(key);
    }
}
exports.InMemoryFollowUpIdempotencyStore = InMemoryFollowUpIdempotencyStore;
class InMemoryFollowUpTaskStore {
    tasks = [];
    list() {
        return [...this.tasks];
    }
    async create(task) {
        const created = {
            ...task,
            id: (0, crypto_1.randomUUID)(),
            createdAt: new Date(),
        };
        this.tasks.push(created);
        return created;
    }
}
exports.InMemoryFollowUpTaskStore = InMemoryFollowUpTaskStore;
exports.defaultFollowUpEventStore = new InMemoryFollowUpEventStore();
exports.defaultFollowUpIdempotencyStore = new InMemoryFollowUpIdempotencyStore();
exports.defaultFollowUpTaskStore = new InMemoryFollowUpTaskStore();
function recordFollowUpEvent(event) {
    exports.defaultFollowUpEventStore.addEvent(event);
}
