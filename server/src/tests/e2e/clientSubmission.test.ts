import request from "supertest";
import app from "../../app";
import fs from "fs";
import path from "path";

const TEST_EMAIL = "submissiontest@boreal.test";

describe("Client → Server Submission Pipeline", () => {

  let token: string;
  let otp: string;
  let applicationId: string;

  test("Start OTP login", async () => {

    const res = await request(app)
      .post("/api/auth/otp/start")
      .send({ email: TEST_EMAIL });

    expect(res.status).toBe(200);

    otp = res.body.otp;

  });

  test("Verify OTP", async () => {

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({
        email: TEST_EMAIL,
        code: otp
      });

    expect(res.status).toBe(200);

    token = res.body.token;

  });

  test("Create application", async () => {

    const res = await request(app)
      .post("/api/applications")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Test Company Ltd",
        contactName: "John Test",
        email: TEST_EMAIL,
        phone: "5551234567",
        requestedAmount: 500000,
        productType: "term_loan"
      });

    expect(res.status).toBe(200);

    applicationId = res.body.id;

  });

  test("Upload document", async () => {

    const filePath = path.join(__dirname, "sample.pdf");

    fs.writeFileSync(filePath, "test document");

    const res = await request(app)
      .post(`/api/documents/upload`)
      .set("Authorization", `Bearer ${token}`)
      .field("applicationId", applicationId)
      .attach("file", filePath);

    expect(res.status).toBe(200);

  });

  test("Trigger SignNow document", async () => {

    const res = await request(app)
      .post(`/api/signnow/initiate`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        applicationId
      });

    expect(res.status).toBe(200);

  });

  test("Fetch created application", async () => {

    const res = await request(app)
      .get(`/api/applications/${applicationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

  });

  test("Fetch application documents", async () => {

    const res = await request(app)
      .get(`/api/documents/application/${applicationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

  });

});
