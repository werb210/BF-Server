"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const app_1 = require("../app");
describe("server:contract:e2e", () => {
    it("accepts canonical OTP start payload", async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .post("/auth/otp/start")
            .send({ phone: "+61400000000" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
    it("rejects legacy otp-only verify payload", async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .post("/auth/otp/verify")
            .send({ phone: "+61400000000", otp: "000000" });
        expect(res.status).toBe(400);
    });
    it("does not expose /api auth aliases", async () => {
        const start = await (0, supertest_1.default)(app_1.app)
            .post("/api/auth/otp/start")
            .send({ phone: "+61400000000" });
        const verify = await (0, supertest_1.default)(app_1.app)
            .post("/api/auth/otp/verify")
            .send({ phone: "+61400000000", code: "654321" });
        expect(start.status).toBe(404);
        expect(verify.status).toBe(404);
    });
    it("rejects missing bearer auth on telephony token", async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .get("/telephony/token");
        expect(res.status).toBe(401);
    });
    it("rejects cookie-only auth on telephony token", async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .get("/telephony/token")
            .set("Cookie", "token=not-a-bearer-token");
        expect(res.status).toBe(401);
    });
    it("full flow works with top-level tokens", async () => {
        const start = await (0, supertest_1.default)(app_1.app)
            .post("/auth/otp/start")
            .send({ phone: "+61400000000" });
        expect(start.status).toBe(200);
        const verify = await (0, supertest_1.default)(app_1.app)
            .post("/auth/otp/verify")
            .send({ phone: "+61400000000", code: "654321" });
        expect(verify.status).toBe(200);
        expect(verify.body.success).toBe(true);
        expect(typeof verify.body.data.token).toBe("string");
    });
    it("does not expose /api telephony token alias", async () => {
        const res = await (0, supertest_1.default)(app_1.app)
            .get("/api/telephony/token");
        expect(res.status).toBe(404);
    });
});
