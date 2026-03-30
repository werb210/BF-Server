"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.post("/ai/escalate", async (_req, res) => {
    await db_1.db.query(`
      insert into live_chat_queue (status)
      values ('waiting')
    `);
    res["json"]({ status: "queued" });
});
exports.default = router;
