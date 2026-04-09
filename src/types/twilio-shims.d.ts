declare module "twilio/lib/jwt/AccessToken" {
  const AccessToken: any;
  export default AccessToken;
  export const VoiceGrant: any;
}

declare module "twilio/lib/twiml/VoiceResponse" {
  const VoiceResponse: any;
  export default VoiceResponse;
}

declare module "twilio/lib/webhooks/webhooks" {
  export function validateRequest(...args: any[]): boolean;
}
