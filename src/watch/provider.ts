import { getBaseUrl, getCallerId, getTwilioClient } from "../voice/twilioClient.js";

export interface WatchCallProvider {
  createCallback(input: { callId: string; callbackNumber: string }): Promise<string>;
  cancel(callSid: string): Promise<void>;
}

export const twilioWatchCallProvider: WatchCallProvider = {
  async createCallback({ callId, callbackNumber }) {
    const from = getCallerId();
    if (!from) throw new Error("provider_not_configured");
    const client = getTwilioClient();
    const call = await client.calls.create({
      to: callbackNumber,
      from,
      url: `${getBaseUrl()}/api/telephony/watch/provider/${callId}/twiml`,
      method: "POST",
      statusCallback: `${getBaseUrl()}/api/telephony/watch/provider/${callId}/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    return call.sid;
  },
  async cancel(callSid) {
    const client = getTwilioClient();
    await client.calls(callSid).update({ status: "canceled" });
  },
};

let provider: WatchCallProvider = twilioWatchCallProvider;
export const getWatchCallProvider = () => provider;
export const setWatchCallProviderForTests = (value: WatchCallProvider) => { provider = value; };
export const resetWatchCallProviderForTests = () => { provider = twilioWatchCallProvider; };

