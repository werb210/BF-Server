export const API_BASE = "/api/v1";

export const endpoints = Object.freeze({
  createLead: `${API_BASE}/leads`,
  startCall: `${API_BASE}/calls/start`,
  updateCallStatus: `${API_BASE}/calls/status`,
  sendMessage: `${API_BASE}/maya/message`,
});
