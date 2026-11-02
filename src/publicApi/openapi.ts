// BF_SERVER_v875_API_KEYS (ported from KS-server #35) - the OpenAPI 3.0 description of the public REST API, served
// without a key at GET /api/open/v1/openapi.json and shown on the portal's Settings > API keys page.
import { API_SCOPES } from "../apiKeys/keys.js";
import { API_STAGES } from "./stages.js";

export const PUBLIC_API_BASE = "/api/open/v1";

export function publicServerUrl(): string {
  return String(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
}

const page = [
  { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 }, description: "Items per page (1-100)." },
  { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 }, description: "Items to skip. Use pagination.next_offset from the previous page." },
];
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string" } });
const ok = (schema: string, list = false) => ({
  description: "OK",
  content: { "application/json": { schema: list
    ? { type: "object", properties: { data: { type: "array", items: { $ref: `#/components/schemas/${schema}` } }, pagination: { $ref: "#/components/schemas/Pagination" } } }
    : { type: "object", properties: { data: { $ref: `#/components/schemas/${schema}` } } } } },
});
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};
const json = (schema: Record<string, unknown>) => ({ required: true, content: { "application/json": { schema } } });
const needs = (scope: string) => ({ "x-required-scope": scope, security: [{ bearerAuth: [scope] }] });
const s = (nullable = true) => ({ type: "string", nullable });
const time = { type: "string", format: "date-time" };

export function openApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Boreal REST API",
      version: "1.0.0",
      description: "Read and update Boreal's contacts, companies, applications, notes, offers and lenders. "
        + "Authenticate with an API key an Admin created in Settings > API keys: `Authorization: Bearer bf_live_...`. "
        + "Each key belongs to one silo (BF, BI or SLF) and only sees that silo's records. Each endpoint needs the "
        + "permission named in x-required-scope (for example contacts:read); a key without it gets 403 insufficient_scope. "
        + "Each key has its own requests-per-minute limit (429 with Retry-After when it is reached). "
        + `Permissions: ${API_SCOPES.join(", ")}.`,
    },
    servers: [{ url: publicServerUrl() + PUBLIC_API_BASE }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/me": { get: { summary: "The key making the request: name, silo, permissions and limit", responses: { "200": ok("Key"), ...errors } } },
      "/contacts": {
        get: { summary: "List contacts", ...needs("contacts:read"), parameters: [...page, { name: "q", in: "query", schema: { type: "string" }, description: "Search name or email." }, { name: "email", in: "query", schema: { type: "string" }, description: "Exact email (case-insensitive)." }], responses: { "200": ok("Contact", true), ...errors } },
        post: { summary: "Create a contact", ...needs("contacts:write"), requestBody: json({ $ref: "#/components/schemas/ContactInput" }), responses: { "201": ok("Contact"), ...errors } },
      },
      "/contacts/{id}": {
        get: { summary: "Get a contact", ...needs("contacts:read"), parameters: [idParam()], responses: { "200": ok("Contact"), ...errors } },
        patch: { summary: "Update a contact", ...needs("contacts:write"), parameters: [idParam()], requestBody: json({ $ref: "#/components/schemas/ContactUpdate" }), responses: { "200": ok("Contact"), ...errors } },
      },
      "/companies": {
        get: { summary: "List companies", ...needs("companies:read"), parameters: [...page, { name: "q", in: "query", schema: { type: "string" }, description: "Search by name." }], responses: { "200": ok("Company", true), ...errors } },
        post: { summary: "Create a company", ...needs("companies:write"), requestBody: json({ $ref: "#/components/schemas/CompanyInput" }), responses: { "201": ok("Company"), ...errors } },
      },
      "/companies/{id}": {
        get: { summary: "Get a company", ...needs("companies:read"), parameters: [idParam()], responses: { "200": ok("Company"), ...errors } },
        patch: { summary: "Update a company", ...needs("companies:write"), parameters: [idParam()], requestBody: json({ $ref: "#/components/schemas/CompanyInput" }), responses: { "200": ok("Company"), ...errors } },
      },
      "/applications": { get: { summary: "List applications", ...needs("applications:read"), parameters: [...page, { name: "stage", in: "query", schema: { type: "string", enum: API_STAGES } }], responses: { "200": ok("Application", true), ...errors } } },
      "/applications/{id}": { get: { summary: "Get an application", ...needs("applications:read"), parameters: [idParam()], responses: { "200": ok("Application"), ...errors } } },
      "/applications/{id}/stage": {
        patch: { summary: "Move an application to another stage (the normal stage rules apply)", ...needs("applications:write"), parameters: [idParam()], requestBody: json({ type: "object", required: ["stage"], properties: { stage: { type: "string", enum: API_STAGES } } }), responses: { "200": ok("Application"), ...errors } },
      },
      "/applications/{id}/notes": {
        get: { summary: "List an application's notes", ...needs("notes:read"), parameters: [idParam(), ...page], responses: { "200": ok("Note", true), ...errors } },
        post: { summary: "Add a note to an application", ...needs("notes:write"), parameters: [idParam()], requestBody: json({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 10000 } } }), responses: { "201": ok("Note"), ...errors } },
      },
      "/applications/{id}/offers": { get: { summary: "List an application's lender offers", ...needs("offers:read"), parameters: [idParam(), ...page], responses: { "200": ok("Offer", true), ...errors } } },
      "/lenders": { get: { summary: "List lenders", ...needs("lenders:read"), parameters: [...page, { name: "active", in: "query", schema: { type: "boolean" } }], responses: { "200": ok("Lender", true), ...errors } } },
      "/lenders/{id}": { get: { summary: "Get a lender", ...needs("lenders:read"), parameters: [idParam()], responses: { "200": ok("Lender"), ...errors } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "An API key: bf_live_..." } },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } },
        },
      },
      schemas: {
        Pagination: { type: "object", properties: { limit: { type: "integer" }, offset: { type: "integer" }, next_offset: { type: "integer", nullable: true } } },
        Key: { type: "object", properties: { name: { type: "string" }, silo: { type: "string" }, scopes: { type: "array", items: { type: "string", enum: [...API_SCOPES] } }, rate_limit_per_minute: { type: "integer" }, key_prefix: { type: "string" } } },
        Contact: { type: "object", properties: {
          id: { type: "string" }, first_name: s(), last_name: s(), name: s(), email: s(), phone: s(), company_id: s(), company_name: s(),
          job_title: s(), lead_status: s(), lifecycle_stage: s(), tags: { type: "array", items: { type: "string" } }, owner_id: s(),
          custom_fields: { type: "object" }, created_at: time, updated_at: time,
        } },
        ContactInput: { type: "object", required: ["first_name", "last_name"], properties: {
          first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
          company_id: { type: "string" }, job_title: { type: "string" },
        } },
        ContactUpdate: { type: "object", properties: {
          first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
          job_title: { type: "string" }, lead_status: { type: "string" },
        } },
        Company: { type: "object", properties: {
          id: { type: "string" }, name: s(), legal_name: s(), dba_name: s(), website: s(), email: s(), phone: s(), industry: s(),
          city: s(), province: s(), country: s(), custom_fields: { type: "object" }, created_at: time, updated_at: time,
        } },
        CompanyInput: { type: "object", required: ["name"], properties: {
          name: { type: "string" }, legal_name: { type: "string" }, website: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
          industry: { type: "string" }, city: { type: "string" }, province: { type: "string" }, country: { type: "string" },
        } },
        Application: { type: "object", properties: {
          id: { type: "string" }, name: { type: "string" }, stage: { type: "string", enum: [...API_STAGES, "Fraud", "Hold"] },
          business_legal_name: s(), requested_amount: { type: "number", nullable: true }, product_category: s(), company_id: s(),
          contact_id: s(), lender_id: s(), submitted_at: { ...time, nullable: true }, funded_amount: { type: "number", nullable: true },
          funded_at: { ...time, nullable: true }, custom_fields: { type: "object" }, created_at: time, updated_at: time,
        } },
        Note: { type: "object", properties: {
          id: { type: "string" }, application_id: { type: "string" }, body: { type: "string" }, owner_id: s(), owner_name: s(),
          created_at: time, updated_at: time,
        } },
        Offer: { type: "object", properties: {
          id: { type: "string" }, application_id: { type: "string" }, lender_id: s(), lender_name: s(), amount: { type: "number", nullable: true },
          rate_factor: s(), term: s(), payment_frequency: s(), expiry_date: s(), status: s(), recommended: { type: "boolean", nullable: true },
          created_at: time, updated_at: time,
        } },
        Lender: { type: "object", properties: {
          id: { type: "string" }, name: { type: "string" }, active: { type: "boolean" }, website: s(), phone: s(), email: s(), country: s(),
          region: s(), city: s(), contact_name: s(), contact_email: s(), contact_phone: s(), created_at: time, updated_at: time,
        } },
      },
    },
  };
}
