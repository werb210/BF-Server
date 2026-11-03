// BF_SERVER_v885_IP_NO_PORT
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { stripForwardedPort, stripPort } from "../stripForwardedPort.js";

describe("IP addresses without Azure's port", () => {
  it("strips ports from IPv4 and bracketed IPv6, leaves the rest", () => {
    expect(stripPort("203.0.113.5:51234")).toBe("203.0.113.5");
    expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripPort("2001:db8::1")).toBe("2001:db8::1");
    expect(stripPort(" 10.0.0.1 ")).toBe("10.0.0.1");
  });
  it("req.ip has no port behind one proxy hop", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(stripForwardedPort);
    app.get("/ip", (req, res) => { res.json({ ip: req.ip }); });
    const r = await request(app).get("/ip").set("X-Forwarded-For", "203.0.113.5:51234");
    expect(r.body.ip).toBe("203.0.113.5");
  });
});
