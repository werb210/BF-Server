import { randomUUID } from "crypto";
import {
  InMemoryFollowUpEventStore,
  InMemoryFollowUpIdempotencyStore,
} from "../modules/followup/followup.store";
import { createFollowUpActionHandlers } from "../modules/followup/followup.actions";
import { evaluateFollowUpRules } from "../modules/followup/followup.engine";
import { followUpRules } from "../modules/followup/followup.rules";

describe("follow-up rules integration", () => {
  it("escalates important email with SMS when unopened", async () => {
    const store = new InMemoryFollowUpEventStore();
    const idempotency = new InMemoryFollowUpIdempotencyStore();

    const smsSender = vi.fn(async () => ({ provider: "test" }));
    const timelineLogger = vi.fn(async () => undefined);

    const handlers = createFollowUpActionHandlers({
      sendSms: smsSender,
      logTimeline: timelineLogger,
    });

    const triggerEvent = {
      id: randomUUID(),
      type: "EMAIL_SENT" as const,
      entityType: "communication" as const,
      entityId: "comm-42",
      occurredAt: new Date("2024-01-01T00:00:00Z"),
      metadata: {
        important: true,
        recipientPhoneNumber: "+15555550100",
      },
    };
    store.addEvent(triggerEvent);

    const rule = followUpRules.find(
      (entry) => entry.id === "IMPORTANT_EMAIL_NOT_OPENED_1H"
    );
    if (!rule) {
      throw new Error("Missing IMPORTANT_EMAIL_NOT_OPENED_1H rule.");
    }

    const results = await evaluateFollowUpRules({
      rules: [rule],
      store,
      idempotency,
      actions: handlers,
      now: new Date("2024-01-01T01:05:00Z"),
    });

    expect(results).toHaveLength(1);
    expect(smsSender).toHaveBeenCalledWith({
      to: "+15555550100",
      body: expect.stringContaining("important email"),
      metadata: expect.any(Object),
    });
    expect(timelineLogger).toHaveBeenCalledTimes(2);
  });
});
