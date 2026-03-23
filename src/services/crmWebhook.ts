import { config } from "@/config";
export async function pushLeadToCRM(data: Record<string, unknown>): Promise<void> {
  if (!config.crm.webhookUrl) {
    return;
  }

  await fetch(config.crm.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
