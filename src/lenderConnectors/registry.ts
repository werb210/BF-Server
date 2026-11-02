// BF_SERVER_v873_LENDER_API - the connectors a brokerage can pick for a lender.
import type { ConnectorKind, LenderConnector } from "./types.js";
import { genericRestConnector } from "./connectors/generic.js";
import { salesforceConnector } from "./connectors/salesforce.js";
import { heronConnector } from "./connectors/heron.js";
import { merchantGrowthConnector } from "./connectors/merchantGrowth.js";

export const CONNECTORS: Record<ConnectorKind, LenderConnector> = {
  generic_rest: genericRestConnector,
  salesforce: salesforceConnector,
  heron: heronConnector,
  merchant_growth: merchantGrowthConnector,
};

export function isConnectorKind(v: unknown): v is ConnectorKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CONNECTORS, v);
}

export function connectorFor(kind: unknown): LenderConnector | null {
  return isConnectorKind(kind) ? CONNECTORS[kind] : null;
}
