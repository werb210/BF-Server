// BF_SERVER_v872_KYC - the ID-verification providers and which one is in use.
//   onfido  Entrust IDV hosted flow (default when ONFIDO_* is set)
//   manual  applicant uploads ID + selfie in the client app, staff approve or decline
// A new vendor is one more KycProvider here; nothing else changes.
import type { KycProvider, KycProviderKey } from "../types.js";
import { onfidoProvider, type BinaryFetch } from "./onfido.js";

export function manualProvider(): KycProvider {
  return {
    key: "manual",
    label: "Manual review (applicant uploads ID and a selfie; staff decide)",
    hosted: false,
    settings: [],
    configured: () => true,
  };
}

export function kycProviders(env: NodeJS.ProcessEnv = process.env, fetchImpl?: BinaryFetch): Record<KycProviderKey, KycProvider> {
  return { onfido: onfidoProvider(env, fetchImpl), manual: manualProvider() };
}

export function isProviderKey(v: unknown): v is KycProviderKey {
  return v === "onfido" || v === "manual";
}

/** The provider in force: the Admin's choice, or automatic (onfido when it is set up, else manual). */
export function resolveProvider(choice: KycProviderKey | null, providers: Record<KycProviderKey, KycProvider>): KycProvider {
  if (choice) return providers[choice];
  return providers.onfido.configured() ? providers.onfido : providers.manual;
}
