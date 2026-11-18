import 'dotenv/config';
import { Injectable } from '@nestjs/common';

export function resolveOpenAIConfig(env: NodeJS.ProcessEnv) {
  if (env.OPENAI_MODEL !== undefined) {
    throw new Error(
      'OPENAI_MODEL is no longer supported; use OPENAI_CHAT_MODEL and optionally OPENAI_CLASSIFICATION_MODEL',
    );
  }
  const value = (name: string, fallback: string) => {
    const configured = env[name] ?? fallback;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(configured)) {
      throw new Error(
        `Invalid ${name}: expected a nonempty model or voice identifier`,
      );
    }
    return configured;
  };
  const chatModel = value('OPENAI_CHAT_MODEL', 'gpt-6-luna');
  return Object.freeze({
    chatModel,
    classificationModel: value('OPENAI_CLASSIFICATION_MODEL', chatModel),
    transcribeModel: value('OPENAI_TRANSCRIBE_MODEL', 'gpt-transcribe'),
    ttsModel: value('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
    voice: value('OPENAI_VOICE', 'cedar'),
  });
}

@Injectable()
export class OpenAIConfig {
  readonly models = resolveOpenAIConfig(process.env);
}

export function resolveRealtimeConfig(env: NodeJS.ProcessEnv) {
  const mode = env.VOICE_RUNTIME_MODE ?? 'legacy';
  if (!['legacy', 'realtime'].includes(mode))
    throw new Error('Invalid VOICE_RUNTIME_MODE');
  const model = env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1-mini';
  const voice = env.OPENAI_REALTIME_VOICE ?? 'marin';
  const filterModel = env.OPENAI_REALTIME_FILTER_MODEL ?? 'gpt-6-luna';
  for (const [name, value] of [
    ['OPENAI_REALTIME_MODEL', model],
    ['OPENAI_REALTIME_VOICE', voice],
    ['OPENAI_REALTIME_FILTER_MODEL', filterModel],
  ]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value!))
      throw new Error(`Invalid ${name}`);
  }
  const duration = (name: string, fallback: number) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 2147483647
    )
      throw new Error(
        `Invalid ${name}: expected milliseconds between 1 and 2147483647`,
      );
    return value;
  };
  return {
    mode: mode as 'legacy' | 'realtime',
    model,
    voice,
    filterModel,
    idleTimeoutMs: duration('REALTIME_IDLE_TIMEOUT_MS', 60000),
    maxSessionMs: duration('REALTIME_MAX_SESSION_MS', 600000),
  };
}
@Injectable()
export class RealtimeConfig {
  readonly settings = resolveRealtimeConfig(process.env);
}
