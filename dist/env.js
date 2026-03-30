"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
if (!process.env.JWT_SECRET) {
    throw new Error("Missing JWT_SECRET");
}
if (!process.env.JWT_REFRESH_SECRET) {
    throw new Error("Missing JWT_REFRESH_SECRET");
}
if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
}
