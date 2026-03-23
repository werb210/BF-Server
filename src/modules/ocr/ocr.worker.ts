import { randomUUID } from "crypto";
import { getOcrEnabled, getOcrPollIntervalMs, getOcrWorkerConcurrency } from "../../server/config/env.compat";
import { isKillSwitchEnabled } from "../ops/ops.service";
import { clearExpiredOcrLocks, lockOcrJobs } from "./ocr.repo";
import { processOcrJob } from "./ocr.service";

export function startOcrWorker(): { stop: () => void } {
  if (!getOcrEnabled()) {
    return { stop: () => undefined };
  }

  const workerId = randomUUID();
  const pollInterval = getOcrPollIntervalMs();
  const concurrency = getOcrWorkerConcurrency();

  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    if (await isKillSwitchEnabled("ocr")) {
      return;
    }
    running = true;
    try {
      const jobs = await lockOcrJobs({ limit: concurrency, lockedBy: workerId });
      await Promise.all(
        jobs.map((job) =>
          processOcrJob(job).catch(() => undefined)
        )
      );
    } catch {
      // swallow
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, pollInterval);

  clearExpiredOcrLocks().catch(() => undefined);

  tick().catch(() => undefined);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
  };

  process.on("SIGTERM", stop);

  return { stop };
}
