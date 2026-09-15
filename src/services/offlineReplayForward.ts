// BF_SERVER_OFFLINE_REPLAY_v250
// Staff offline actions replayed through POST /api/pwa/sync are forwarded to the
// real live route on this same server, carrying the staff member's own
// Authorization and silo. Validation, permissions and database writes are
// therefore exactly the online ones - nothing is re-implemented here.
//
// Only additive actions are allowed. Edits to shared records stay online-only,
// because two offline edits to one record have no safe automatic merge.
import { AppError } from "../middleware/errors.js";
import { config } from "../config/index.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const FORWARDABLE_REPLAY_PATHS: RegExp[] = [
  new RegExp(`^/api/crm/(contacts|companies)/${UUID}/notes$`, "i"),
  /^\/api\/tasks$/,
  new RegExp(`^/api/tasks/${UUID}/complete$`, "i"),
  /^\/api\/telephony\/calls\/[A-Za-z0-9_-]{1,64}\/disposition$/,
];

export function isForwardableReplayPath(path: string): boolean {
  return FORWARDABLE_REPLAY_PATHS.some((re) => re.test(path));
}

export type ReplayForwardContext = { authorization: string; silo?: string | null };

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: () => Promise<string> }>;

export async function forwardReplayAction(
  action: { path: string; body: Record<string, unknown> },
  forward: ReplayForwardContext | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  port: number = Number(config.port ?? 8080),
): Promise<{ statusCode: number; body: unknown }> {
  if (!isForwardableReplayPath(action.path)) {
    throw new AppError("unsupported_replay", "Replay action is not supported.", 400);
  }
  if (!forward?.authorization) {
    throw new AppError("auth_required", "Replay requires the caller's authorization.", 401);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: forward.authorization,
    "x-offline-replay": "1",
  };
  if (forward.silo) headers["x-silo"] = forward.silo;

  const response = await fetchImpl(`http://127.0.0.1:${port}${action.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(action.body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (response.status >= 400) {
    const b = body as { code?: unknown; error?: { code?: unknown } } | null;
    const code = String(b?.error?.code ?? b?.code ?? "replay_forward_failed");
    throw new AppError(code, `Replay of ${action.path} failed (${response.status}).`, response.status);
  }
  return { statusCode: response.status, body };
}
