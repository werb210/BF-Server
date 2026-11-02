// BF_SERVER_v875_WEBHOOKS (ported from KS-server #39) - the events an endpoint can subscribe to, and the JSON each
// delivery carries.
//
// Every delivery is a POST with Content-Type application/json and this body:
//   { "id": "<event id, the same for every endpoint and every retry>", "type": "contact.created", "silo": "BF",
//     "created_at": "<ISO time of the change>", "data": { "object": { ...the record... }, ...extra } }
// An endpoint with a batch size above 1 gets the events that are due together as one JSON array of those bodies
// (a Zapier "Catch Hook" runs the Zap once for each item of an array).
// Headers: X-Webhook-Event (type, or "batch"), X-Webhook-Id (event id), X-Webhook-Delivery (this delivery),
// X-Webhook-Attempt, X-Webhook-Batch-Size (batches), X-Webhook-Timestamp and X-Webhook-Signature (signing.ts).
// Receivers should treat the event id as an idempotency key: a delivery can arrive more than once.
//
// Events are captured by row triggers (migrations/2026_11_16_v875_integrations.sql), so every write path - the
// portal, the client app, the website, imports, Maya, lender webhooks, the public API - fires them, per silo.

export const EVENT_TYPES = [
  "contact.created", "contact.updated", "company.created", "company.updated", "application.created",
  "application.stage_changed", "application.signed", "document.uploaded", "offer.created", "offer.status_changed",
  "deal.funded", "note.added",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

export type ObjectKind = "contact" | "company" | "application" | "document" | "offer" | "note";

/** Fields sent for each record type (anything else on the row stays private). Custom fields go with them. */
export const OBJECT_FIELDS: Record<ObjectKind, readonly string[]> = {
  contact: ["id", "silo", "first_name", "last_name", "name", "email", "phone", "secondary_email", "secondary_phone", "job_title",
    "company_id", "company_name", "lead_status", "lifecycle_stage", "status", "role", "tags", "owner_id",
    "address_street", "address_city", "address_state", "address_zip", "address_country", "marketing_opt_out",
    "sms_opt_out", "created_at", "updated_at", "custom_fields"],
  company: ["id", "silo", "name", "legal_name", "dba_name", "website", "domain", "email", "phone", "industry", "city", "province",
    "region", "country", "address_street", "address_city", "address_state", "address_zip", "address_country",
    "annual_revenue", "estimated_annual_revenue", "employee_count", "number_of_employees", "types_of_financing", "tags",
    "owner_id", "status", "created_at", "updated_at", "custom_fields"],
  application: ["id", "silo", "name", "business_legal_name", "product_type", "product_category", "pipeline_state", "status",
    "requested_amount", "funded_amount", "funded_currency", "funded_at", "lender_id", "lender_product_id", "contact_id",
    "company_id", "owner_user_id", "source", "submitted_at", "signnow_app_signed_at", "expected_close_date", "created_at",
    "updated_at", "custom_fields"],
  document: ["id", "application_id", "document_type", "category", "filename", "display_name", "status", "uploaded_by",
    "size_bytes", "created_at"],
  offer: ["id", "application_id", "lender_id", "lender_name", "amount", "rate_factor", "term", "payment_frequency",
    "expiry_date", "status", "recommended", "created_at", "updated_at"],
  note: ["id", "silo", "body", "contact_id", "company_id", "application_id", "owner_id", "created_at"],
};

/** Renamed on the way out so the payload reads plainly. */
const RENAME: Record<string, string> = { pipeline_state: "stage", signnow_app_signed_at: "signed_at" };

export type EventDef = { type: EventType; label: string; object: ObjectKind; description: string };

export const EVENTS: readonly EventDef[] = [
  { type: "contact.created", label: "Contact created", object: "contact", description: "A contact is added: by hand, by the application wizard, the website, an import, a booking or a call." },
  { type: "contact.updated", label: "Contact updated", object: "contact", description: "Any of a contact's details or custom fields change." },
  { type: "company.created", label: "Company created", object: "company", description: "A company is added." },
  { type: "company.updated", label: "Company updated", object: "company", description: "Any of a company's details or custom fields change." },
  { type: "application.created", label: "Application created", object: "application", description: "A new application is started (client app, staff, website, import or broker)." },
  { type: "application.stage_changed", label: "Stage changed", object: "application", description: "An application moves to another pipeline stage. data.from_stage and data.to_stage say where from and to." },
  { type: "application.signed", label: "Application signed", object: "application", description: "The client signs the application." },
  { type: "document.uploaded", label: "Document uploaded", object: "document", description: "A document is added to an application. The file itself is not sent." },
  { type: "offer.created", label: "Offer received", object: "offer", description: "A lender offer is added to an application." },
  { type: "offer.status_changed", label: "Offer status changed", object: "offer", description: "An offer is accepted, declined or otherwise changes status. data.from_status and data.to_status say how." },
  { type: "deal.funded", label: "Deal funded", object: "application", description: "An application is funded. data.object.funded_amount and funded_currency say how much." },
  { type: "note.added", label: "Note added", object: "note", description: "A note is added to a contact, company or application." },
];

export function eventDef(type: string): EventDef | undefined {
  return EVENTS.find((e) => e.type === type);
}

function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
}

/** The record as sent: only the listed fields, in that order, missing ones as null. */
export function shapeObject(kind: ObjectKind, raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const row = raw ?? {};
  const out: Record<string, unknown> = { object: kind };
  for (const f of OBJECT_FIELDS[kind]) {
    const key = RENAME[f] ?? f;
    const v = row[f];
    out[key] = f === "custom_fields" ? (v && typeof v === "object" ? v : {}) : v === undefined ? null : jsonSafe(v);
  }
  return out;
}

export type DeliveryRow = {
  event_id: string; event_type: string; object_type: string | null; occurred_at: string | Date; silo?: string | null;
  payload: { object?: Record<string, unknown>; extra?: Record<string, unknown> } | null;
};

/** The JSON body of one event (the same on every attempt). */
export function eventBody(row: DeliveryRow): Record<string, unknown> {
  const def = eventDef(row.event_type);
  const kind = (def?.object ?? row.object_type ?? "contact") as ObjectKind;
  const extra = row.payload?.extra && typeof row.payload.extra === "object" ? row.payload.extra : {};
  const occurred = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(String(row.occurred_at)).toISOString();
  return {
    id: row.event_id,
    type: row.event_type,
    silo: row.silo ?? null,
    created_at: occurred,
    data: { object: shapeObject(kind, row.payload?.object), ...extra },
  };
}

export function buildBody(row: DeliveryRow): string {
  return JSON.stringify(eventBody(row));
}

/** A batch: a JSON array of event bodies, oldest first. */
export function buildBatchBody(rows: DeliveryRow[]): string {
  return JSON.stringify(rows.map(eventBody));
}

const SAMPLE_TIME = "2026-11-16T15:04:05.000Z";
const CONTACT_ID = "6f1c2b9e-3a5d-4c7e-9f10-2b3c4d5e6f70";
const COMPANY_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const APP_ID = "8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a";
const OWNER_ID = "11111111-2222-4333-8444-555555555555";
const SAMPLE_OBJECTS: Record<ObjectKind, Record<string, unknown>> = {
  contact: { id: CONTACT_ID, silo: "BF", first_name: "Jordan", last_name: "Lee", name: "Jordan Lee", email: "jordan@example.com",
    phone: "+15555550123", job_title: "Owner", company_id: COMPANY_ID, company_name: "Northwind Trucking",
    lead_status: "New", lifecycle_stage: "lead", status: "prospect", role: "applicant", tags: ["equipment"],
    owner_id: OWNER_ID, address_city: "Calgary", address_state: "AB", address_country: "CA",
    marketing_opt_out: false, sms_opt_out: false, created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME,
    custom_fields: { fleet_size: 12 } },
  company: { id: COMPANY_ID, silo: "BF", name: "Northwind Trucking", legal_name: "Northwind Trucking Ltd.", website: "https://northwind.example",
    industry: "Transportation", city: "Calgary", province: "AB", country: "CA", employee_count: 14, tags: [],
    owner_id: OWNER_ID, status: "prospect", created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME, custom_fields: {} },
  application: { id: APP_ID, silo: "BF", name: "Northwind Trucking", business_legal_name: "Northwind Trucking Ltd.",
    product_type: "standard", product_category: "EQUIPMENT", pipeline_state: "In Review", status: "In Review", requested_amount: 250000,
    funded_amount: null, funded_currency: "CAD", funded_at: null, contact_id: CONTACT_ID, company_id: COMPANY_ID,
    owner_user_id: OWNER_ID, source: "client_app", submitted_at: SAMPLE_TIME, signnow_app_signed_at: null,
    created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME, custom_fields: {} },
  document: { id: "doc_7e6d5c4b", application_id: APP_ID, document_type: "bank_statements", category: "bank_statements",
    filename: "march-statement.pdf", status: "uploaded", uploaded_by: "client", size_bytes: 482113, created_at: SAMPLE_TIME },
  offer: { id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", application_id: APP_ID, lender_id: "22222222-3333-4444-8555-666666666666",
    lender_name: "Example Equipment Finance", amount: 240000, rate_factor: "1.18", term: "48 months", payment_frequency: "monthly",
    expiry_date: "2026-12-01", status: "pending", recommended: true, created_at: SAMPLE_TIME, updated_at: SAMPLE_TIME },
  note: { id: "c3b2a1f0-9e8d-4c7b-a6f5-e4d3c2b1a0f9", silo: "BF", body: "Spoke to Jordan; sending the March statement today.",
    contact_id: CONTACT_ID, company_id: null, application_id: null, owner_id: OWNER_ID, created_at: SAMPLE_TIME },
};

/** An example body for each event, for the Settings > Webhooks documentation and "Send test event". */
export function sampleBody(type: EventType, eventId = "evt_example", silo = "BF"): Record<string, unknown> {
  const def = eventDef(type)!;
  let obj: Record<string, unknown> = { ...SAMPLE_OBJECTS[def.object] };
  if ("silo" in obj) obj.silo = silo;
  let extra: Record<string, unknown> = {};
  if (type === "application.stage_changed") extra = { from_stage: "Documents Required", to_stage: "In Review" };
  if (type === "application.signed") obj = { ...obj, signnow_app_signed_at: SAMPLE_TIME };
  if (type === "offer.status_changed") { obj = { ...obj, status: "accepted" }; extra = { from_status: "pending", to_status: "accepted" }; }
  if (type === "deal.funded") obj = { ...obj, pipeline_state: "Funded", funded_amount: 240000, funded_at: SAMPLE_TIME };
  return eventBody({ event_id: eventId, event_type: type, object_type: def.object, occurred_at: SAMPLE_TIME, silo, payload: { object: obj, extra } });
}
