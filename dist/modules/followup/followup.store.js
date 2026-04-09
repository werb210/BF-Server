import { randomUUID } from "node:crypto";
export class InMemoryFollowUpEventStore {
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
export class InMemoryFollowUpIdempotencyStore {
    processed = new Set();
    has(key) {
        return this.processed.has(key);
    }
    mark(key) {
        this.processed.add(key);
    }
}
export class InMemoryFollowUpTaskStore {
    tasks = [];
    list() {
        return [...this.tasks];
    }
    async create(task) {
        const created = {
            ...task,
            id: randomUUID(),
            createdAt: new Date(),
        };
        this.tasks.push(created);
        return created;
    }
}
export const defaultFollowUpEventStore = new InMemoryFollowUpEventStore();
export const defaultFollowUpIdempotencyStore = new InMemoryFollowUpIdempotencyStore();
export const defaultFollowUpTaskStore = new InMemoryFollowUpTaskStore();
export function recordFollowUpEvent(event) {
    defaultFollowUpEventStore.addEvent(event);
}
