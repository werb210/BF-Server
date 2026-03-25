import { describe, it, expect } from "vitest"
import request from "supertest"
import { createServer } from "../src/server/createServer"

describe("E2E ROUTES", () => {
  const app = createServer()

  it("health works", async () => {
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
  })

  it("OTP start route exists", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+1234567890" })

    expect(res.status).not.toBe(404)
  })

  it("OTP verify route exists", async () => {
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+1234567890", code: "123456" })

    expect(res.status).not.toBe(404)
  })

  it("telephony requires auth", async () => {
    const res = await request(app).get("/telephony/token")
    expect(res.status).toBe(401)
  })
})
