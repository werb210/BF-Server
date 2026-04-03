import type { Response } from "express";

type MaybeResponse = Response | unknown;

function isResponse(value: unknown): value is Response {
  return Boolean(
    value
      && typeof value === "object"
      && "status" in (value as Record<string, unknown>)
      && "json" in (value as Record<string, unknown>),
  );
}

export function ok(first: Response, second: unknown): Response;
export function ok(first: unknown, second?: string): { status: "ok"; data: unknown; rid?: string };
export function ok(first: unknown, second?: unknown): Response | { status: "ok"; data: unknown; rid?: string } {
  if (isResponse(first)) {
    return first.status(200).json({ status: "ok", data: second });
  }

  return {
    status: "ok" as const,
    data: first,
    rid: typeof second === "string" ? second : undefined,
  };
}

export function fail(first: Response, second: unknown, third?: number): Response;
export function fail(first: unknown, second?: string): { status: "error"; error: string; rid?: string };
export function fail(first: unknown, second?: unknown, third = 400): Response | { status: "error"; error: string; rid?: string } {
  if (isResponse(first)) {
    const message = typeof second === "string" ? second : "error";
    return first.status(third).json({ status: "error", error: message });
  }

  return {
    status: "error" as const,
    error: first instanceof Error ? first.message : String(first),
    rid: typeof second === "string" ? second : undefined,
  };
}

export function error(message: string, rid?: string) {
  return {
    status: "error",
    error: message,
    rid,
  };
}
