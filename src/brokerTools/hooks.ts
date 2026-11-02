// BF_SERVER_v865_BROKER_TOOLS - what happens across the broker tools when a file moves to Funded. Each step is best effort and
// logs its own failure: the stage change has already happened and must not be undone by a follow-on step.
type Step = { name: string; run: (applicationId: string) => Promise<void> };

const STEPS: Step[] = [];

/** Registers a step to run after a file is funded (used by the credit lines and the vendor portal). */
export function onFunded(name: string, run: (applicationId: string) => Promise<void>): void {
  if (!STEPS.some((s) => s.name === name)) STEPS.push({ name, run });
}

export async function afterFunded(applicationId: string): Promise<void> {
  await import("./hookRegistry.js");
  for (const step of STEPS) {
    try {
      await step.run(applicationId);
    } catch (err) {
      console.error("[broker-tools] after-funded step failed", { step: step.name, applicationId, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
