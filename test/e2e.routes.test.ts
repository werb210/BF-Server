import request from "supertest"
import { createServer } from "../src/server/createServer"

describe("E2E SERVER AUDIT", () => {
  let app: any

  beforeAll(() => {
    app = createServer()
  })

  it("server boots", () => {
    expect(app).toBeDefined()
  })

  it("health route works", async () => {
    const res = await request(app).get("/health")
    expect(res.status).not.toBe(404)
  })

  it("auth OTP start route exists", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "+1234567890" })

    expect(res.status).not.toBe(404)
  })

  it("auth OTP verify route exists", async () => {
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phone: "+1234567890", code: "123456" })

    expect(res.status).not.toBe(404)
  })

  it("no double prefix", async () => {
    const res = await request(app)
      .post("/api/api/auth/otp/start")
      .send({ phone: "+1234567890" })

    expect(res.status).toBe(404)
  })

  it("protected route requires auth", async () => {
    const res = await request(app).get("/telephony/token")
    expect(res.status).toBe(401)
  })

  it("invalid input rejected", async () => {
    const res = await request(app)
      .post("/auth/otp/start")
      .send({ phone: "" })

    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it("unknown route returns 404", async () => {
    const res = await request(app).get("/does-not-exist")
    expect(res.status).toBe(404)
  })
})
