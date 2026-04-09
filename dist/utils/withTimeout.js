export function withTimeout(promise, ms = 5000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), ms);
        }),
    ]);
}
