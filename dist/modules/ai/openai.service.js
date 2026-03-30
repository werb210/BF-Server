"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.askAI = askAI;
const openai_1 = __importDefault(require("openai"));
const config_1 = require("../../config");
let client = null;
function fetchClient() {
    if (client)
        return client;
    const apiKey = config_1.config.openai.apiKey;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for AI chat.");
    }
    client = new openai_1.default({ apiKey });
    return client;
}
async function askAI(messages) {
    const completion = await fetchClient().chat.completions.create({
        model: config_1.config.openai.chatModel ?? "gpt-4o-mini",
        messages,
        temperature: 0.4,
    });
    return completion.choices[0]?.message?.content ?? "No response.";
}
