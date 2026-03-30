"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTwilioSignature = verifyTwilioSignature;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
function verifyTwilioSignature(signature, url, params) {
    const data = Object.keys(params)
        .sort()
        .reduce((acc, key) => acc + key + params[key], url);
    const computed = crypto_1.default
        .createHmac("sha1", config_1.config.twilio.authToken)
        .update(data)
        .digest("base64");
    return computed === signature;
}
