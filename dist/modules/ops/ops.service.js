import { runQuery } from "../../db.js";
import { config } from "../../config/index.js";
export const OPS_KILL_SWITCH_KEYS = [
    "replay",
    "exports",
    "lender_transmission",
    "ocr",
];
function fetchEnvKillSwitch(key) {
    if (key === "replay") {
        return config.flags.opsKillSwitchReplay;
    }
    if (key === "exports") {
        return config.flags.opsKillSwitchExports;
    }
    if (key === "ocr") {
        return config.flags.opsKillSwitchOcr;
    }
    return config.flags.opsKillSwitchLenderTransmission;
}
export async function listKillSwitches() {
    const result = await runQuery("select key, enabled from ops_kill_switches");
    const dbMap = new Map(result.rows.map((row) => [row.key, Boolean(row.enabled)]));
    return OPS_KILL_SWITCH_KEYS.map((key) => {
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
export async function setKillSwitch(key, enabled) {
    await runQuery(`insert into ops_kill_switches (key, enabled, updated_at)
     values ($1, $2, now())
     on conflict (key)
     do update set enabled = excluded.enabled, updated_at = excluded.updated_at`, [key, enabled]);
}
export async function isKillSwitchEnabled(key) {
    if (fetchEnvKillSwitch(key)) {
        return true;
    }
    const result = await runQuery("select enabled from ops_kill_switches where key = $1", [key]);
    return result.rows[0]?.enabled ?? false;
}
