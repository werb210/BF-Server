if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL missing during CI — skipping DB checks");
  process.exit(0);
}

import("../dist/index.js")
  .then(() => {
    console.log("Build verification passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
