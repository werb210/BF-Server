import { randomUUID } from "crypto";
import { type PoolClient } from "pg";
import { pool, runQuery } from "../../db";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type CallDirection = "outbound" | "inbound";
export type CallStatus =
  | "initiated"
  | "ringing"
  | "in_progress"
  | "connected"
  | "ended"
  | "failed"
  | "no_answer"
  | "busy"
  | "completed"
  | "canceled"
  | "cancelled";

export type CallLogRecord = {
  id: string;
  phone_number: string;
  from_number: string | null;
  to_number: string | null;
  twilio_call_sid: string | null;
  direction: CallDirection;
  status: CallStatus;
  duration_seconds: number | null;
  staff_user_id: string | null;
  crm_contact_id: string | null;
  application_id: string | null;
  error_code: string | null;
  error_message: string | null;
  recording_sid: string | null;
  recording_duration_seconds: number | null;
  created_at: Date;
  started_at: Date;
  ended_at: Date | null;
};

export async function createCallLog(params: {
  phoneNumber: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  direction: CallDirection;
  status: CallStatus;
  staffUserId: string | null;
  twilioCallSid?: string | null;
  crmContactId?: string | null;
  applicationId?: string | null;
  client?: Queryable;
}): Promise<CallLogRecord> {
  const runner = params.client ?? pool;
  const id = randomUUID();
  const hasTwilioSid = Boolean(params.twilioCallSid);
  const conflictClause = hasTwilioSid
    ? `on conflict (twilio_call_sid)
       do update set phone_number = call_logs.phone_number`
    : "";
  const res = await runner.query<CallLogRecord>(
    `insert into call_logs
     (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, crm_contact_id,
      application_id, created_at, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
     ${conflictClause}
     returning id, phone_number, from_number, to_number, twilio_call_sid, direction, status, duration_seconds,
               staff_user_id, crm_contact_id, application_id, error_code, error_message, recording_sid,
               recording_duration_seconds, created_at, started_at, ended_at`,
    [
      id,
      params.phoneNumber,
      params.fromNumber ?? null,
      params.toNumber ?? null,
      params.twilioCallSid ?? null,
      params.direction,
      params.status,
      params.staffUserId,
      params.crmContactId ?? null,
      params.applicationId ?? null,
    ]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Call log insert failed.");
  }
  return record;
}

export async function findCallLogById(
  id: string,
  client?: Queryable
): Promise<CallLogRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<CallLogRecord>(
    `select id, phone_number, from_number, to_number, twilio_call_sid, direction, status, duration_seconds,
            staff_user_id, crm_contact_id, application_id, error_code, error_message, recording_sid,
            recording_duration_seconds, created_at, started_at, ended_at
     from call_logs
     where id = $1
     limit 1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function findCallLogByTwilioSid(
  twilioCallSid: string,
  client?: Queryable
): Promise<CallLogRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<CallLogRecord>(
    `select id, phone_number, from_number, to_number, twilio_call_sid, direction, status, duration_seconds,
            staff_user_id, crm_contact_id, application_id, error_code, error_message, recording_sid,
            recording_duration_seconds, created_at, started_at, ended_at
     from call_logs
     where twilio_call_sid = $1
     limit 1`,
    [twilioCallSid]
  );
  return res.rows[0] ?? null;
}

export async function listCallLogs(params: {
  contactId?: string | null;
  applicationId?: string | null;
  client?: Queryable;
}): Promise<CallLogRecord[]> {
  const runner = params.client ?? pool;
  const filters: string[] = [];
  const values: string[] = [];
  if (params.contactId) {
    values.push(params.contactId);
    filters.push(`crm_contact_id = $${values.length}`);
  }
  if (params.applicationId) {
    values.push(params.applicationId);
    filters.push(`application_id = $${values.length}`);
  }
  const whereClause = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
  const res = await runner.query<CallLogRecord>(
    `select id, phone_number, from_number, to_number, twilio_call_sid, direction, status, duration_seconds,
            staff_user_id, crm_contact_id, application_id, error_code, error_message, recording_sid,
            recording_duration_seconds, created_at, started_at, ended_at
     from call_logs
     ${whereClause}
     order by created_at desc`,
    values
  );
  return res.rows;
}

export async function updateCallLogStatus(params: {
  id: string;
  status: CallStatus;
  durationSeconds?: number | null;
  endedAt?: Date | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordingSid?: string | null;
  recordingDurationSeconds?: number | null;
  client?: Queryable;
}): Promise<CallLogRecord | null> {
  const runner = params.client ?? pool;
  const updates: Array<{ name: string; value: unknown }> = [
    { name: "status", value: params.status },
  ];
  if (params.durationSeconds !== undefined) {
    updates.push({ name: "duration_seconds", value: params.durationSeconds });
  }
  if (params.endedAt !== undefined) {
    updates.push({ name: "ended_at", value: params.endedAt });
  }
  if (params.fromNumber !== undefined) {
    updates.push({ name: "from_number", value: params.fromNumber });
  }
  if (params.toNumber !== undefined) {
    updates.push({ name: "to_number", value: params.toNumber });
  }
  if (params.errorCode !== undefined) {
    updates.push({ name: "error_code", value: params.errorCode });
  }
  if (params.errorMessage !== undefined) {
    updates.push({ name: "error_message", value: params.errorMessage });
  }
  if (params.recordingSid !== undefined) {
    updates.push({ name: "recording_sid", value: params.recordingSid });
  }
  if (params.recordingDurationSeconds !== undefined) {
    updates.push({
      name: "recording_duration_seconds",
      value: params.recordingDurationSeconds,
    });
  }

  const setClauses = updates.map(
    (entry, index) => `${entry.name} = $${index + 1}`
  );
  const values = updates.map((entry) => entry.value);
  values.push(params.id);

  const res = await runner.query<CallLogRecord>(
    `update call_logs
     set ${setClauses.join(", ")}
     where id = $${values.length}
     returning id, phone_number, from_number, to_number, twilio_call_sid, direction, status, duration_seconds,
               staff_user_id, crm_contact_id, application_id, error_code, error_message, recording_sid,
               recording_duration_seconds, created_at, started_at, ended_at`,
    values
  );
  return res.rows[0] ?? null;
}
