import {
  type CommunicationRepoRow,
  type MessageRepoRow,
  listCommunications,
  listMessages,
} from "./communications.repo";

export type CommunicationParticipant = {
  id: string;
  email: string | null;
  phone: string | null;
};

export type CommunicationRecord = {
  id: string;
  type: string | null;
  direction: string;
  status: string;
  duration: number;
  twilioSid: string | null;
  contactId: string | null;
  userId: string | null;
  createdAt: Date | null;
  contact: CommunicationParticipant | null;
  user: CommunicationParticipant | null;
};

export type CommunicationMessage = CommunicationRecord & {
  body: string | null;
};

export type MessageFeed = {
  messages: CommunicationMessage[];
  total: number;
};

function buildParticipant(params: {
  recordId: string | null;
  email: string | null;
  phone: string | null;
}): CommunicationParticipant | null {
  if (!params.recordId) {
    return null;
  }

  return {
    id: params.recordId,
    email: params.email ?? null,
    phone: params.phone ?? null,
  };
}

function normalizeCommunication(row: CommunicationRepoRow): CommunicationRecord {
  const contact = buildParticipant({
    recordId: row.contact_record_id,
    email: row.contact_email,
    phone: row.contact_phone,
  });

  const user = buildParticipant({
    recordId: row.user_record_id,
    email: row.user_email,
    phone: row.user_phone,
  });

  return {
    id: row.id,
    type: row.type ?? null,
    direction: row.direction ?? "unknown",
    status: row.status ?? "unknown",
    duration: row.duration ?? 0,
    twilioSid: row.twilio_sid ?? null,
    contactId: row.contact_id ?? null,
    userId: row.user_id ?? null,
    createdAt: row.created_at ?? null,
    contact,
    user,
  };
}

function normalizeMessage(row: MessageRepoRow): CommunicationMessage {
  return {
    ...normalizeCommunication(row),
    body: row.body ?? null,
  };
}

export async function fetchCommunications(params: {
  contactId?: string | null;
}): Promise<CommunicationRecord[]> {
  const rows = await listCommunications({
    ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
  });
  if (rows.length === 0) {
    return [];
  }

  return rows.map((row) => normalizeCommunication(row));
}

export async function fetchMessageFeed(params: {
  contactId?: string | null;
  page: number;
  pageSize: number;
}): Promise<MessageFeed> {
  const rows = await listMessages({
    ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
    page: params.page,
    pageSize: params.pageSize,
  });

  if (rows.length === 0) {
    return { messages: [], total: 0 };
  }

  const total = rows[0]?.total_count ?? 0;
  return {
    messages: rows.map((row) => normalizeMessage(row)),
    total,
  };
}
