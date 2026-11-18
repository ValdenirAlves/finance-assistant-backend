import { Injectable } from '@nestjs/common';

export function resolveLiveConfig(env: NodeJS.ProcessEnv) {
  const enabled = env.GPT_LIVE_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled))
    throw new Error('Invalid GPT_LIVE_ENABLED');
  const model = env.OPENAI_LIVE_MODEL ?? 'gpt-live-1';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))
    throw new Error('Invalid OPENAI_LIVE_MODEL');
  const voice = env.OPENAI_LIVE_VOICE ?? 'vesper';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(voice))
    throw new Error('Invalid OPENAI_LIVE_VOICE');
  const duration = (name: string, fallback: number) => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 2147483647
    )
      throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    enabled: enabled === 'true',
    model,
    voice,
    idleTimeoutMs: duration('LIVE_IDLE_TIMEOUT_MS', 60000),
    maxSessionMs: duration('LIVE_MAX_SESSION_MS', 600000),
  };
}

@Injectable()
export class LiveConfig {
  readonly settings = resolveLiveConfig(process.env);
}

export function liveLog(event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'development')
    console.debug(JSON.stringify({ event: `live.${event}`, ...fields }));
}

export function liveErrorDetails(error: unknown) {
  const value =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const provider =
    value.error && typeof value.error === 'object'
      ? (value.error as Record<string, unknown>)
      : value;
  const safe = (text: unknown) =>
    typeof text === 'string'
      ? text
          .replaceAll(process.env.OPENAI_API_KEY || '\u0000', '[redacted]')
          .replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[redacted]')
          .slice(0, 350)
      : undefined;
  return {
    status: typeof value.status === 'number' ? value.status : undefined,
    code: safe(provider.code),
    errorName: safe(value.name),
    message: safe(provider.message),
  };
}
