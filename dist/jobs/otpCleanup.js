export async function cleanupOtpSessions(database) {
    await database.query(`
    DELETE FROM otp_sessions
    WHERE expires_at < NOW()
  `);
}
