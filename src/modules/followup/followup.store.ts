import { randomUUID } from "node:crypto";
import {
  type FollowUpEvent,
  type FollowUpEventStore,
  type FollowUpIdempotencyStore,
  type FollowUpTask,
} from "./followup.types";

export class InMemoryFollowUpEventStore implements FollowUpEventStore {
  private events: FollowUpEvent[] = [];

  addEvent(event: FollowUpEvent): void {
    this.events.push(event);
  }

  listEvents(filter?: {
    type?: FollowUpEvent["type"];
    entityType?: FollowUpEvent["entityType"];
    entityId?: string;
  }): FollowUpEvent[] {
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

export class InMemoryFollowUpIdempotencyStore
  implements FollowUpIdempotencyStore
{
  private processed = new Set<string>();

  has(key: string): boolean {
    return this.processed.has(key);
  }

  mark(key: string): void {
    this.processed.add(key);
  }
}

export class InMemoryFollowUpTaskStore {
  private tasks: FollowUpTask[] = [];

  list(): FollowUpTask[] {
    return [...this.tasks];
  }

  async create(task: Omit<FollowUpTask, "id" | "createdAt">): Promise<FollowUpTask> {
    const created: FollowUpTask = {
      ...task,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.tasks.push(created);
    return created;
  }
}

export const defaultFollowUpEventStore = new InMemoryFollowUpEventStore();
export const defaultFollowUpIdempotencyStore =
  new InMemoryFollowUpIdempotencyStore();
export const defaultFollowUpTaskStore = new InMemoryFollowUpTaskStore();

export function recordFollowUpEvent(event: FollowUpEvent): void {
  defaultFollowUpEventStore.addEvent(event);
}
