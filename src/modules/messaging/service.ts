import { sendSMS } from "../../services/smsService";

type SendMessagePayload = {
  to: string;
  body: string;
};

export async function sendMessage(payload: SendMessagePayload) {
  if (!payload?.to || !payload?.body) {
    throw new Error("Both 'to' and 'body' are required.");
  }

  await sendSMS(payload.to, payload.body);
  return { success: true };
}
