// BF_SERVER_v817_AUDIO_MODELS - OpenAI retires tts-1 (Jan 6 2027) and whisper-1 (Feb 26 2027).
// The model names now come from settings, defaulting to the current replacements, and every call
// falls back once to the legacy model so a model that is not enabled on the account never leaves
// the phone menu silent or a voicemail untranscribed.
export const LEGACY_TTS_MODEL = "tts-1";
export const LEGACY_TRANSCRIBE_MODEL = "whisper-1";

export function ttsModel(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.OPENAI_TTS_MODEL ?? "").trim() || "gpt-4o-mini-tts";
}

export function transcribeModel(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.OPENAI_TRANSCRIBE_MODEL ?? "").trim() || "gpt-4o-mini-transcribe";
}

/** Runs `call` with the configured model, then once with the legacy model if that fails. */
export async function withAudioModelFallback<T>(
  primary: string,
  legacy: string,
  call: (model: string) => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await call(primary);
  } catch (err: any) {
    if (primary === legacy) throw err;
    console.warn("openai_audio_model_fallback", { label, model: primary, fallback: legacy, reason: String(err?.message ?? err).slice(0, 200) });
    return await call(legacy);
  }
}
