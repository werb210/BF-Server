"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhone = normalizePhone;
const phone_1 = require("./phone");
function normalizePhone(input) {
    return (0, phone_1.tryNormalizePhone)(input) ?? "";
}
