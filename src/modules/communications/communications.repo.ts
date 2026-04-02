import { type PoolClient } from "pg";
import { pool, runQuery } from "../../db";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type CommunicationRepoRow = {
  id: string;
  type: string | null;
  direction: string | null;
  status: string | null;
  duration: number | null;
  twilio_sid: string | null;
  contact_id: string | null;
  user_id: string | null;
  created_at: Date | null;
  contact_record_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  user_record_id: string | null;
  user_email: string | null;
  user_phone: string | null;
};

export type MessageRepoRow = CommunicationRepoRow & {
  body: string | null;
  total_count: number | null;
};

export async function listCommunications(params: {
  contactId?: string | null;
  client?: Queryable;
}): Promise<CommunicationRepoRow[]> {
  const runner = params.client ?? pool;
  const values: Array<string> = [];
  const conditions: string[] = [];

  if (params.contactId) {
    values.push(params.contactId);
    conditions.push(`c.contact_id = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  const result = await runner.query<CommunicationRepoRow>(
    `
      select
        c.id,
        c.type,
        c.direction,
        c.status,
        c.duration,
        c.twilio_sid,
        c.contact_id,
        c.user_id,
        c.created_at,
        contact.id as contact_record_id,
        contact.email as contact_email,
        contact.phone as contact_phone,
        owner.id as user_record_id,
        owner.email as user_email,
        owner.phone as user_phone
      from communications c
      left join contacts contact on contact.id = c.contact_id
      left join users owner on owner.id = c.user_id
      ${whereClause}
      order by c.created_at desc nulls last
    `,
    values
  );

  if (!result.rows.length) {
    return [];
  }

  return result.rows;
}

export async function listMessages(params: {
  contactId?: string | null;
  page: number;
  pageSize: number;
  client?: Queryable;
}): Promise<MessageRepoRow[]> {
  const runner = params.client ?? pool;
  const values: Array<string | number> = [];
  const conditions: string[] = [];

  if (params.contactId) {
    values.push(params.contactId);
    conditions.push(`m.contact_id = $${values.length}`);
  }

  const offset = Math.max(params.page - 1, 0) * params.pageSize;
  values.push(params.pageSize);
  values.push(offset);

  const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  const result = await runner.query<MessageRepoRow>(
    `
      select
        m.id,
        m.type,
        m.direction,
        m.status,
        m.duration,
        m.twilio_sid,
        m.contact_id,
        m.user_id,
        m.created_at,
        m.body,
        contact.id as contact_record_id,
        contact.email as contact_email,
        contact.phone as contact_phone,
        owner.id as user_record_id,
        owner.email as user_email,
        owner.phone as user_phone,
        count(*) over()::int as total_count
      from communications_messages m
      left join contacts contact on contact.id = m.contact_id
      left join users owner on owner.id = m.user_id
      ${whereClause}
      order by m.created_at desc nulls last
      limit $${values.length - 1}
      offset $${values.length}
    `,
    values
  );

  if (!result.rows.length) {
    return [];
  }

  return result.rows;
}
