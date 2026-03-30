"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContinuation = createContinuation;
exports.fetchContinuation = fetchContinuation;
exports.updateContinuationStep = updateContinuationStep;
exports.completeContinuation = completeContinuation;
const node_crypto_1 = __importDefault(require("node:crypto"));
const db_1 = require("../db");
async function createContinuation(applicationId) {
    const token = node_crypto_1.default.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await db_1.db.query(`
      insert into continuation_sessions (
        application_id,
        token,
        expires_at,
        application_status,
        current_step,
        last_updated,
        is_completed
      )
      values ($1, $2, $3, 'in_progress', 1, now(), false)
    `, [applicationId, token, expiresAt]);
    return token;
}
async function fetchContinuation(token) {
    const { rows } = await db_1.db.query(`
      select application_id
      from continuation_sessions
      where token = $1 and expires_at > now() and is_completed = false
    `, [token]);
    return rows[0]?.application_id ?? null;
}
async function updateContinuationStep(token, currentStep) {
    await db_1.db.query(`
      update continuation_sessions
      set current_step = $2,
          last_updated = now()
      where token = $1
    `, [token, currentStep]);
}
async function completeContinuation(token) {
    await db_1.db.query(`
      update continuation_sessions
      set is_completed = true,
          application_status = 'completed',
          last_updated = now()
      where token = $1
    `, [token]);
}
