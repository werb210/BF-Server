"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.API_ROUTES = void 0;
exports.API_ROUTES = {
    health: "/api/v1/health",
    auth: {
        otpStart: "/api/v1/auth/otp/start",
        otpVerify: "/api/v1/auth/otp/verify",
    },
    application: {
        create: "/api/v1/applications",
        upload: "/api/v1/documents",
    },
};
