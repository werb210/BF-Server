// BF_SERVER_v905_APP_LAUNCH - client app launch email (with draw) and Todd's lender note.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { APP_LAUNCH_DIR, loadYearEndTemplates, seedAppLaunchTemplates, yearEndFields } from "../startup/seedYearEndTemplates.js";
import { renderBrandedEmail } from "../services/emailTemplateRender.js";

const all = loadYearEndTemplates(APP_LAUNCH_DIR);

describe("app launch templates", () => {
  it("has the client announcement and the lender note, images on disk", () => {
    expect(all.map((t) => t.group)).toEqual(["Clients", "Lenders"]);
    for (const f of ["app-phones.jpg", "app-prize.jpg"]) expect(fs.existsSync(path.join(APP_LAUNCH_DIR, f))).toBe(true);
  });
  it("client email: two columns, Get the app, and the draw's legal lines", () => {
    const f = yearEndFields(all[0]!, "https://server.example.test", "applaunch", 1);
    expect(f.headline).toBe("Boreal is now on your phone");
    expect(f.heroUrl).toBe("https://server.example.test/api/public/email/applaunch/app-phones.jpg");
    expect(f.rightImageUrl).toBe("https://server.example.test/api/public/email/applaunch/app-prize.jpg");
    expect(f.ctaUrl).toMatch(/^https:\/\/boreal\.financial\/app\?/);
    expect(f.cta2Url).toBe("https://boreal.financial/app-draw-rules");
    for (const re of [/No purchase necessary/, /excluding Quebec/, /skill-testing question/, /info@boreal\.financial/]) expect(f.body2).toMatch(re);
    const html = renderBrandedEmail(f);
    expect(html).toContain("email-column");
    expect(html).toContain("Official rules");
  });
  it("lender note: plain, no image, no button, signed by Todd", () => {
    const f = yearEndFields(all[1]!, "https://server.example.test", "applaunch", 1);
    expect(f.heroUrl).toBe("");
    expect(f.headline).toBe("");
    expect(f.ctaLabel).toBe("");
    expect(f.body).toMatch(/CSBFP/);
    expect(f.body).toMatch(/Just reply to this email\./);
    expect(f.body).toContain("Todd Werboweski");
  });
  it("seeds both into BF as applaunch-seed", async () => {
    const query = vi.fn(async () => ({ rows: [] as unknown[] }));
    const out = await seedAppLaunchTemplates({ query } as any, { publicBase: "https://server.example.test" });
    expect(out).toMatchObject({ total: 2, inserted: 2 });
    const ins = query.mock.calls.filter((c: unknown[]) => /INSERT INTO marketing_template/.test(String(c[0])));
    expect((ins[0] as any)[1][6]).toBe("applaunch-seed");
  });
  it("serves the app launch images publicly", async () => {
    const { default: publicRoutes } = await import("../routes/public.js");
    const app = express();
    app.use("/api/public", publicRoutes);
    expect((await request(app).get("/api/public/email/applaunch/app-phones.jpg")).status).toBe(200);
    expect((await request(app).get("/api/public/email/ye26/clients-01.jpg")).status).toBe(200);
    expect((await request(app).get("/api/public/email/other/app-phones.jpg")).status).toBe(404);
  });
});
