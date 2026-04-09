export function log(level, msg, ctx = {}) {
    console.log(JSON.stringify({
        level,
        msg,
        time: new Date().toISOString(),
        ...ctx,
    }));
}
