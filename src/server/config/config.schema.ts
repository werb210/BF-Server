export type AppConfig = {
  auth: {
    jwtSecret: string;
    refreshSecret: string;
    accessExpiresIn: string;
    refreshExpiresMs: number;
  };
  documents: {
    maxSizeBytes: number;
    allowedMimeTypes: string[];
  };
  ocr: {
    timeoutMs: number;
  };
  lender: {
    retry: {
      baseDelayMs: number;
      maxDelayMs: number;
      maxCount: number;
    };
  };
  followUp: {
    intervalMs: number;
    enabled: boolean;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  client: {
    submissionOwnerUserId: string | null;
  };
};
