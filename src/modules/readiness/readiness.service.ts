import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbQuery } from "../../db.js";
import { normalizePhoneNumber } from "../auth/phone.js";
import { upsertCrmLead } from "../crm/leadUpsert.service.js";
import { stripUndefined, toNullable } from "../../utils/clean.js";

const readinessSourceSchema = z.enum(["website", "client"]);

const numericFromUnknown = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().finite().nonnegative().optional());

const integerFromUnknown = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().int().nonnegative().optional());

const booleanFromUnknown = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean().optional());

export const createReadinessLeadSchema = z.object({
  companyName: z.string().trim().min(2),
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email(),
  industry: z.string().trim().min(2).optional(),
  yearsInBusiness: integerFromUnknown,
  monthlyRevenue: numericFromUnknown,
  annualRevenue: numericFromUnknown,
  arOutstanding: numericFromUnknown,
  existingDebt: booleanFromUnknown,
});

export type CreateReadinessLeadInput = z.infer<typeof createReadinessLeadSchema> & {
  source?: z.infer<typeof readinessSourceSchema>;
};


function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRequiredPhone(phone: string): string {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) {
    throw new Error("invalid_phone");
  }
  return normalized;
}

async function findExistingContactId(params: {
  email: string;
  phone: string;
}): Promise<string | null> {
  const result = await dbQuery<{ id: string }>(
    `select id
     from contacts
     where lower(email) = lower($1)
        or phone = $2
     order by created_at asc
     limit 1`,
    [params.email, params.phone]
  );
  return result.rows[0]?.id ?? null;
}

async function createContact(params: {
  fullName: string;
  email: string;
  phone: string;
  sourceTag: "readiness_v1" | "startup_interest";
}): Promise<string> {
  const id = randomUUID();
  await dbQuery(
    `insert into contacts (id, name, email, phone, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())`,
    [id, params.fullName, params.email, params.phone, params.sourceTag]
  );
  return id;
}

export async function linkCrmContact(params: {
  fullName: string;
  email: string;
  phone: string;
  startupInterest?: boolean;
}): Promise<string> {
  const existingId = await findExistingContactId({
    email: params.email,
    phone: params.phone,
  });

  if (existingId) {
    await dbQuery(
      `update contacts
       set status = $2,
           updated_at = now()
       where id = $1`,
      [existingId, params.startupInterest ? "startup_interest" : "readiness_v1"]
    );
    return existingId;
  }

  return createContact({
    fullName: params.fullName,
    email: params.email,
    phone: params.phone,
    sourceTag: params.startupInterest ? "startup_interest" : "readiness_v1",
  });
}

export async function createReadinessLead(input: CreateReadinessLeadInput): Promise<{ leadId: string }> {
  const parsed = createReadinessLeadSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const phone = normalizeRequiredPhone(parsed.phone);

  const source = readinessSourceSchema.parse(input.source ?? "website");

  const crmContactId = await linkCrmContact({
    fullName: parsed.fullName,
    email,
    phone,
  });

  const { id: crmLeadId } = await upsertCrmLead(stripUndefined({
    companyName: parsed.companyName,
    fullName: parsed.fullName,
    email,
    phone,
    industry: parsed.industry,
    yearsInBusiness: toNullable(parsed.yearsInBusiness),
    monthlyRevenue: toNullable(parsed.monthlyRevenue),
    annualRevenue: toNullable(parsed.annualRevenue),
    arOutstanding: toNullable(parsed.arOutstanding),
    existingDebt: toNullable(parsed.existingDebt),
    source: `readiness_${source}`,
    tags: ["readiness"],
    activityType: "readiness_submission",
    activityPayload: { source },
  }));

  void crmContactId;

  return { leadId: crmLeadId };
}

