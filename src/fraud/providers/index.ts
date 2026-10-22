// BF_SERVER_v846_FRAUD - every outside service the fraud checks can use, in one place, plus a plain list of which are
// set up (shown to Admins on the Fraud settings card so nobody mistakes "not set up" for "all clear").
import type { FetchLike } from "./http.js";
import { corporationsCanadaProvider, type RegistryProvider } from "./registry.js";
import {
  addressProvider, idvProvider, ipinfoProvider, rdapProvider, twilioLineTypeProvider, voiceProvider,
  type AddressProvider, type DomainAgeProvider, type IdvProvider, type IpIntelProvider, type LineTypeProvider, type VoiceProvider,
} from "./lookups.js";

export type FraudProviders = {
  registry: RegistryProvider;
  domainAge: DomainAgeProvider;
  lineType: LineTypeProvider;
  ipIntel: IpIntelProvider;
  idv: IdvProvider;
  voice: VoiceProvider;
  address: AddressProvider;
};

export function fraudProviders(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): FraudProviders {
  return {
    registry: corporationsCanadaProvider(env, fetchImpl),
    domainAge: rdapProvider(env, fetchImpl),
    lineType: twilioLineTypeProvider(env, fetchImpl),
    ipIntel: ipinfoProvider(env, fetchImpl),
    idv: idvProvider(env),
    voice: voiceProvider(env),
    address: addressProvider(env),
  };
}

export type ProviderStatus = { key: keyof FraudProviders; label: string; provider: string; configured: boolean; setting: string; used_by: string[] };

export function providerStatus(p: FraudProviders): ProviderStatus[] {
  return [
    { key: "registry", label: "Corporate registry (Canada federal)", provider: p.registry.name, configured: p.registry.configured(), setting: "CORPORATIONS_CANADA_API_KEY", used_by: ["fraud_6"] },
    { key: "domainAge", label: "Website and email domain age", provider: p.domainAge.name, configured: p.domainAge.configured(), setting: "on by default (FRAUD_RDAP=off turns it off)", used_by: ["fraud_6", "fraud_7"] },
    { key: "lineType", label: "Phone line type", provider: p.lineType.name, configured: p.lineType.configured(), setting: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN", used_by: ["fraud_6", "fraud_7"] },
    { key: "ipIntel", label: "IP address location and VPN", provider: p.ipIntel.name, configured: p.ipIntel.configured(), setting: "IPINFO_TOKEN", used_by: ["fraud_9"] },
    { key: "idv", label: "ID verification vendor", provider: p.idv.name, configured: p.idv.configured(), setting: "not available yet (vendor to be chosen)", used_by: ["fraud_8"] },
    { key: "voice", label: "Voice / deepfake analysis vendor", provider: p.voice.name, configured: p.voice.configured(), setting: "not available yet (vendor to be chosen)", used_by: ["fraud_15"] },
    { key: "address", label: "Address verification vendor", provider: p.address.name, configured: p.address.configured(), setting: "not available yet (built-in mail-drop list is used)", used_by: ["fraud_6"] },
  ];
}
