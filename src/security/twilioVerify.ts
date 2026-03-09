import crypto from "crypto";

export function verifyTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const computed = crypto
    .createHmac("sha1", authToken!)
    .update(data)
    .digest("base64");

  return computed === signature;
}
