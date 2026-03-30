"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateEmbedding = generateEmbedding;
const openai_1 = __importDefault(require("openai"));
const config_1 = require("../../config");
const client = new openai_1.default({
    apiKey: config_1.config.openai.apiKey || "test-openai-key",
});
async function generateEmbedding(text) {
    const response = await client.embeddings.create({
        model: config_1.config.openai.embedModel ?? config_1.config.ai.embedModel ?? "text-embedding-3-small",
        input: text,
    });
    return response.data[0]?.embedding ?? [];
}
