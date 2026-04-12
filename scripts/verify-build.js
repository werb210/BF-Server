import("../dist/index.js")
  .then(() => {
    console.log("Build verification passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Build verification failed:", err);
    process.exit(1);
  });
