import { EventEmitter } from "events";

export type SystemEventName =
  | "application_created"
  | "document_uploaded"
  | "documents_complete"
  | "offer_created"
  | "offer_accepted"
  | "message_received"
  | "lender_submission_created";

const bus = new EventEmitter();

async function forwardToAgent(event: SystemEventName, payload: Record<string, unknown>): Promise<void> {
  const endpoint = process.env.AGENT_EVENTS_URL;
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, payload }),
    });
  } catch {
    // swallow forwarding failures so API calls stay reliable
  }
}

export const eventBus = {
  emit(event: SystemEventName, payload: Record<string, unknown>): boolean {
    void forwardToAgent(event, payload);
    return bus.emit(event, payload);
  },
  on: bus.on.bind(bus),
};
