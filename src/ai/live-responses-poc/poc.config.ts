import { Injectable } from '@nestjs/common';
import { resolveLiveConfig } from '../live/live.config.js';
import { resolveOpenAIConfig } from '../openai.config.js';

export function resolvePocConfig(env: NodeJS.ProcessEnv) {
  const flag = env.GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('Invalid GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT');
  return {
    enabled: env.NODE_ENV === 'development' && flag === 'true',
    live: resolveLiveConfig(env),
    backendModel: resolveOpenAIConfig(env).chatModel,
  };
}
@Injectable()
export class PocConfig {
  readonly settings = resolvePocConfig(process.env);
}

export function pocLog(event: string, fields: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'development')
    console.debug(
      JSON.stringify({ event: `live.responses_${event}`, ...fields }),
    );
}
