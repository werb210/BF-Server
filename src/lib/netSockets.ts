// BF_SERVER_SNAT_REUSE_v784 - what is holding outbound connections. Logged every 5 minutes as "[net-sockets]" so a
// future SNAT problem can be traced to the service responsible from the log stream.
import net from "node:net";

export function summarizeSockets(): { total: number; byDestination: Record<string, number> } {
  const handles: unknown[] = typeof (process as any)._getActiveHandles === "function" ? (process as any)._getActiveHandles() : [];
  const byDestination: Record<string, number> = {};
  let total = 0;
  for (const h of handles) {
    if (!(h instanceof net.Socket)) continue;
    const s = h as net.Socket & { servername?: string; _host?: string };
    if (!s.remoteAddress || !s.remotePort || s.remotePort === Number(process.env.PORT ?? 0)) continue;
    if (s.localPort && s.localPort === Number(process.env.PORT ?? 8080)) continue; // inbound requests, not SNAT
    const name = s.servername || s._host || s.remoteAddress;
    const dest = `${name}:${s.remotePort}`;
    byDestination[dest] = (byDestination[dest] ?? 0) + 1;
    total++;
  }
  return { total, byDestination };
}

export function startSocketReport(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      const { total, byDestination } = summarizeSockets();
      const top = Object.entries(byDestination).sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.info("[net-sockets]", JSON.stringify({ total, top: Object.fromEntries(top) }));
    } catch (err: unknown) {
      console.warn("[net-sockets] report failed", err instanceof Error ? err.message : String(err));
    }
  }, intervalMs);
  t.unref();
  return t;
}
