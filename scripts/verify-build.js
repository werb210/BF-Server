import("../dist/index.js")
  .then(() => {
    console.log("Build verification passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
