const sendNotification = vi.fn(() => Promise.resolve());
const setVapidDetails = vi.fn();
const getVapidHeaders = vi.fn(() => ({}));
const generateVAPIDKeys = vi.fn(() => ({
  publicKey: "test-public",
  privateKey: "test-private",
}));

class WebPushError extends Error {}

const supportedContentEncodings = ["aes128gcm"];

const mockModule = {
  sendNotification,
  setVapidDetails,
  getVapidHeaders,
  generateVAPIDKeys,
  WebPushError,
  supportedContentEncodings,
};

export {
  sendNotification,
  setVapidDetails,
  getVapidHeaders,
  generateVAPIDKeys,
  WebPushError,
  supportedContentEncodings,
};

export default mockModule;
