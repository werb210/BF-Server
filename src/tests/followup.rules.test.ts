import { randomUUID } from "crypto";
import {
  InMemoryFollowUpEventStore,
  InMemoryFollowUpIdempotencyStore,
} from "../modules/followup/followup.store";
import {
  createFollowUpActionHandlers,
} from "../modules/followup/followup.actions";
import { evaluateFollowUpRules, isConditionMet } from "../modules/followup/followup.engine";
import { followUpRules } from "../modules/followup/followup.rules";

function buildHandlers() {
  return createFollowUpActionHandlers({
    sendSms: vi.fn(async () => ({ provider: "test" })),
    createTask: vi.fn(async () => undefined),
    logTimeline: vi.fn(async () => undefined),
  });
}

describe("follow-up rules engine", () => {
  it("respects time-based not-event conditions", () => {
    const store = new InMemoryFollowUpEventStore();
    const triggerEvent = {
      id: randomUUID(),
      type: "EMAIL_SENT" as const,
      entityType: "communication" as const,
      entityId: "comm-1",
      occurredAt: new Date("2024-01-01T00:00:00Z"),
      metadata: { important: true },
    };
    store.addEvent(triggerEvent);

    const condition = {
      type: "not_event_since" as const,
      eventType: "EMAIL_OPENED" as const,
      minutes: 60,
    };

    expect(
      isConditionMet(condition, {
        triggerEvent,
        now: new Date("2024-01-01T00:30:00Z"),
        store,
      })
    ).toBe(false);

    expect(
      isConditionMet(condition, {
        triggerEvent,
        now: new Date("2024-01-01T01:01:00Z"),
        store,
      })
    ).toBe(true);
  });

  it("executes rules idempotently", async () => {
    const store = new InMemoryFollowUpEventStore();
    const idempotency = new InMemoryFollowUpIdempotencyStore();
    const handlers = buildHandlers();

    const triggerEvent = {
      id: randomUUID(),
      type: "DOC_REJECTED" as const,
      entityType: "document" as const,
      entityId: "doc-1",
      occurredAt: new Date("2024-01-01T00:00:00Z"),
      metadata: { rejection_count: 2 },
    };
    store.addEvent(triggerEvent);

    const rule = followUpRules.find((entry) => entry.id === "DOC_REJECTED_TWICE");
    if (!rule) {
      throw new Error("Missing DOC_REJECTED_TWICE rule.");
    }

    const firstRun = await evaluateFollowUpRules({
      rules: [rule],
      store,
      idempotency,
      actions: handlers,
      now: new Date("2024-01-01T00:05:00Z"),
    });

    const secondRun = await evaluateFollowUpRules({
      rules: [rule],
      store,
      idempotency,
      actions: handlers,
      now: new Date("2024-01-01T00:06:00Z"),
    });

    expect(firstRun).toHaveLength(1);
    expect(secondRun).toHaveLength(0);
    expect(handlers.createTask).toHaveBeenCalledTimes(1);
  });
});
