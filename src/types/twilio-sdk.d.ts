declare module "twilio" {
  interface TwilioSDK {
    (accountSid?: string, authToken?: string, opts?: unknown): unknown;
    new (accountSid?: string, authToken?: string, opts?: unknown): unknown;
    validateRequest: (
      authToken: string,
      twilioHeader: string,
      url: string,
      params: Record<string, unknown>
    ) => boolean;
    jwt: {
      AccessToken: {
        new (
          accountSid: string,
          apiKeySid: string,
          apiKeySecret: string,
          options?: { identity?: string; ttl?: number }
        ): {
          addGrant: (grant: unknown) => void;
          toJwt: () => string;
        };
        VoiceGrant: new (options: { outgoingApplicationSid?: string; incomingAllow?: boolean }) => unknown;
      };
    };
    twiml: {
      VoiceResponse: new () => {
        dial: (attrs?: Record<string, unknown>) => { client: (identity: string) => void };
        say: (text: string) => void;
        record: (attrs: Record<string, unknown>) => void;
        toString: () => string;
      };
    };
  }

  const twilio: TwilioSDK;
  export default twilio;
}
