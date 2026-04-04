"use strict";
process.on("unhandledRejection", (e) => {
    console.error("[UNHANDLED REJECTION]", e);
});
process.on("uncaughtException", (e) => {
    console.error("[UNCAUGHT EXCEPTION]", e);
});
