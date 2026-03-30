"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.twilioClient = void 0;
const twilio_1 = __importDefault(require("twilio"));
const config_1 = require("../config");
exports.twilioClient = new twilio_1.default(config_1.config.twilio.accountSid, config_1.config.twilio.authToken);
exports.default = exports.twilioClient;
