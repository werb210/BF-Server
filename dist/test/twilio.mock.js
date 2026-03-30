"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockTwilio = void 0;
// no jest dependency → pure stub
exports.mockTwilio = {
    messages: {
        create: async () => ({ sid: "mock-sid" }),
    },
};
