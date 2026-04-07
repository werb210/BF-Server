import OpenAI from "openai";
import Redis from "ioredis";

import { initDb } from "../db/init";
import { deps } from "../system/deps";

export async function verifyRuntime() {
  console.log("🔍 VERIFYING RUNTIME...");

  // ---------------------------
  // DATABASE
  // ---------------------------
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing");
  }

  try {
    await initDb();

    if (!deps.db.ready || !deps.db.client) {
      throw new Error("DATABASE FAILED TO INITIALIZE");
    }

    console.log("✅ DATABASE OK");
  } catch (err) {
    console.error("❌ DATABASE FAILED");
    throw err;
  }

  // ---------------------------
  // REDIS
  // ---------------------------
  if (process.env.REDIS_URL) {
    try {
      const redis = new Redis(process.env.REDIS_URL);
      await redis.ping();
      console.log("✅ REDIS OK");
      redis.disconnect();
    } catch (err) {
      console.error("❌ REDIS FAILED");
      throw err;
    }
  } else {
    console.log("⚠️ REDIS SKIPPED");
  }

  // ---------------------------
  // OPENAI
  // ---------------------------
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    await openai.models.list();
    console.log("✅ OPENAI OK");
  } catch (err) {
    console.error("❌ OPENAI FAILED");
    throw err;
  }

  // ---------------------------
  // TWILIO
  // ---------------------------
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const client = require("twilio")(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );

      await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      console.log("✅ TWILIO OK");
    } catch (err) {
      console.error("❌ TWILIO FAILED");
      throw err;
    }
  } else {
    console.log("⚠️ TWILIO PARTIAL CONFIG");
  }

  console.log("🚀 RUNTIME VERIFIED");
}
