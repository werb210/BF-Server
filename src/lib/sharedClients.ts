// BF_SERVER_SNAT_REUSE_v784 - one client per key, reused for the life of the process.
// Azure App Service gives each instance a fixed number of outbound connections (SNAT ports, ~384 here). Creating a
// fresh OpenAI or Twilio client per call opened brand-new connections every time (OpenAI v4 has a pool per client;
// Twilio v4 does not keep connections alive by default). The server sat at ~371 of 384 all day, so a restart burst
// exhausted the ports and every outbound connection - including the database - timed out for minutes (Oct 8 2026).
import OpenAI from "openai";
import twilio from "twilio";

const openaiByKey = new Map<string, OpenAI>();
export function sharedOpenAI(apiKey: string | undefined = process.env.OPENAI_API_KEY): OpenAI {
  const key = String(apiKey ?? "");
  let c = openaiByKey.get(key);
  if (!c) { c = new OpenAI({ apiKey: key }); openaiByKey.set(key, c); }
  return c;
}

const twilioByKey = new Map<string, any>();
export function sharedTwilio(accountSid: string, authToken: string): any {
  const key = accountSid + ":" + authToken;
  let c = twilioByKey.get(key);
  if (!c) {
    const RequestClient = (twilio as any).RequestClient;
    c = RequestClient ? twilio(accountSid, authToken, { httpClient: new RequestClient({ keepAlive: true }) }) : twilio(accountSid, authToken);
    twilioByKey.set(key, c);
  }
  return c;
}
