export function log(level: string, msg: string, ctx: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level,
      msg,
      time: new Date().toISOString(),
      ...ctx,
    })
  );
}
