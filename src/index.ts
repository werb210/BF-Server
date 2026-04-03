import app from "./app";

const port = process.env.PORT || 8080;

console.log("🔥 SERVER BOOT START");

app.listen(port, () => {
  console.log(`🚀 SERVER RUNNING ON ${port}`);
});

(async () => {
  console.log("⏳ INIT START");

  try {
    const { initDb } = await import("./db/init");
    await Promise.race([
      initDb(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), 5000)
      ),
    ]);

    console.log("✅ DB READY");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("⚠️ DB FAILED (non-blocking)", message);
  }
})();
