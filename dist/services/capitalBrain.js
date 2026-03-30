"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scorePreApplication = scorePreApplication;
const openai_1 = __importDefault(require("openai"));
const config_1 = require("../config");
function fetchAzureClient() {
    if (!config_1.config.azureOpenai.key || !config_1.config.azureOpenai.endpoint) {
        throw new Error("Azure OpenAI credentials are not configured.");
    }
    return new openai_1.default({
        apiKey: config_1.config.azureOpenai.key,
        baseURL: config_1.config.azureOpenai.endpoint,
    });
}
async function scorePreApplication(data) {
    if (!config_1.config.azureOpenai.deployment) {
        throw new Error("AZURE_OPENAI_DEPLOYMENT is not configured.");
    }
    const prompt = `
Evaluate this business for credit readiness.
Return a score from 1-10 and a short reason.

${JSON.stringify(data)}
`;
    const openai = fetchAzureClient();
    const response = await openai.chat.completions.create({
        model: config_1.config.azureOpenai.deployment,
        messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0]?.message?.content ?? null;
}
