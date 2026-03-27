export function getTelephonyStatus() {
  return {
    enabled: !!process.env.TWILIO_ACCOUNT_SID,
  };
}
