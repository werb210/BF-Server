import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { isKillSwitchEnabled } from "../ops/ops.service.js";
import { clearExpiredOcrLocks, lockOcrJobs } from "./ocr.repo.js";
import { processOcrJob } from "./ocr.service.js";

export function startOcrWorker(): { stop: () => void } {
  if (!config.features.ocrEnabled) {
    return { stop: () => undefined };
  }

  const workerId = randomUUID();
  const pollInterval = config.ocr.pollIntervalMs;
  const concurrency = config.ocr.workerConcurrency;

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
