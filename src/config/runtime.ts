import { config } from "@/config";

function requireValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required runtime config: ${name}`);
  }
  return value;
}

export const API_BASE = requireValue("API_BASE_URL", config.urls.apiBase);

export const PUBLIC_BASE = requireValue("PUBLIC_BASE_URL", config.urls.publicBase);

export const CLIENT_BASE = requireValue("CLIENT_BASE_URL", config.urls.clientBase);

export const ALLOWED_ORIGINS = [PUBLIC_BASE, CLIENT_BASE];
