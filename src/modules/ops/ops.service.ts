import { pool } from "../../db";
import { config } from "../../config";

export const OPS_KILL_SWITCH_KEYS = [
  "replay",
  "exports",
  "lender_transmission",
  "ocr",
] as const;

export type OpsKillSwitchKey = (typeof OPS_KILL_SWITCH_KEYS)[number];

function fetchEnvKillSwitch(key: OpsKillSwitchKey): boolean {
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

export async function listKillSwitches(): Promise<
  Array<{ key: OpsKillSwitchKey; enabled: boolean; envEnabled: boolean; dbEnabled: boolean }>
> {
  const result = await pool.runQuery<{ key: OpsKillSwitchKey; enabled: unknown }>(
    "select key, enabled from ops_kill_switches"
  );
  const dbMap = new Map<OpsKillSwitchKey, boolean>(
    result.rows.map((row) => [row.key, Boolean(row.enabled)])
  );
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

export async function setKillSwitch(
  key: OpsKillSwitchKey,
  enabled: boolean
): Promise<void> {
  await pool.runQuery(
    `insert into ops_kill_switches (key, enabled, updated_at)
     values ($1, $2, now())
     on conflict (key)
     do update set enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [key, enabled]
  );
}

export async function isKillSwitchEnabled(
  key: OpsKillSwitchKey
): Promise<boolean> {
  if (fetchEnvKillSwitch(key)) {
    return true;
  }
  const result = await pool.runQuery<{ enabled: boolean }>(
    "select enabled from ops_kill_switches where key = $1",
    [key]
  );
  return result.rows[0]?.enabled ?? false;
}
