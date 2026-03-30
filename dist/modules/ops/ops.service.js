"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPS_KILL_SWITCH_KEYS = void 0;
exports.listKillSwitches = listKillSwitches;
exports.setKillSwitch = setKillSwitch;
exports.isKillSwitchEnabled = isKillSwitchEnabled;
const db_1 = require("../../db");
const config_1 = require("../../config");
exports.OPS_KILL_SWITCH_KEYS = [
    "replay",
    "exports",
    "lender_transmission",
    "ocr",
];
function fetchEnvKillSwitch(key) {
    if (key === "replay") {
        return config_1.config.flags.opsKillSwitchReplay;
    }
    if (key === "exports") {
        return config_1.config.flags.opsKillSwitchExports;
    }
    if (key === "ocr") {
        return config_1.config.flags.opsKillSwitchOcr;
    }
    return config_1.config.flags.opsKillSwitchLenderTransmission;
}
async function listKillSwitches() {
    const result = await db_1.pool.query("select key, enabled from ops_kill_switches");
    const dbMap = new Map(result.rows.map((row) => [row.key, Boolean(row.enabled)]));
    return exports.OPS_KILL_SWITCH_KEYS.map((key) => {
        const envEnabled = fetchEnvKillSwitch(key);
        const dbEnabled = dbMap.get(key) ?? false;
        return {
            key,
            enabled: envEnabled || dbEnabled,
            envEnabled,
            dbEnabled,
        };
    });
}
async function setKillSwitch(key, enabled) {
    await db_1.pool.query(`insert into ops_kill_switches (key, enabled, updated_at)
     values ($1, $2, now())
     on conflict (key)
     do update set enabled = excluded.enabled, updated_at = excluded.updated_at`, [key, enabled]);
}
async function isKillSwitchEnabled(key) {
    if (fetchEnvKillSwitch(key)) {
        return true;
    }
    const result = await db_1.pool.query("select enabled from ops_kill_switches where key = $1", [key]);
    return result.rows[0]?.enabled ?? false;
}
