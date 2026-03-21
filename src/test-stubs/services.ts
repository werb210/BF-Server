const IS_TEST = process.env.TEST_MODE === "true" || process.env.NODE_ENV === "test";

export const mockSuccess = async () => ({ success: true });

export const sendSMS = IS_TEST
  ? mockSuccess
  : async (...args: any[]) => {
      const { sendSMS: realSendSMS } = await import("../services/smsService");
      return (realSendSMS as any)(...args);
    };

export const sendEmail = IS_TEST ? mockSuccess : mockSuccess;

export const uploadFile = IS_TEST
  ? async () => ({ url: "test-file-url" })
  : async (...args: any[]) => {
      const { uploadDocumentBuffer: realUpload } = await import("../services/storage/blobStorage");
      return (realUpload as any)(...args);
    };
