import crypto from "crypto";
import { config } from "../config";

export function verifyTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const computed = crypto
    .createHmac("sha1", config.twilio.authToken)
    .update(data)
    .digest("base64");

  return computed === signature;
}
