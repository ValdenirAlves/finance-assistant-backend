import { OpenAIConfig } from '../openai.config.js';
import {
  Inject,
  Injectable,
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { validateAudio } from './audio.js';
import type { AudioUpload } from './audio.js';
import { timing } from './voice-timing.js';

export const TTS_TIMEOUT_MS = 15000;
export class TtsTimeoutError extends Error {
  constructor() {
    super('Speech synthesis timed out');
    this.name = 'TtsTimeoutError';
  }
}

@Injectable()
/** Legacy file transcription / MP3 synthesis adapter; not used by WebRTC. */
export class AudioService {
  constructor(
    @Inject(OpenAIConfig)
    private readonly openAIConfig: OpenAIConfig = new OpenAIConfig(),
  ) {}
  private client() {
    if (!process.env.OPENAI_API_KEY)
      throw new ServiceUnavailableException('AI service is not configured');
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 0,
    });
  }
  async transcribe(file: AudioUpload) {
    const { mime, extension } = validateAudio(file);
    const client = this.client();
    let text: string;
    try {
      const result = await client.audio.transcriptions.create({
        model: this.openAIConfig.models.transcribeModel,
        file: await toFile(file.buffer, `recording.${extension}`, {
          type: mime,
        }),
      });
      timing('transcription_model', {
        model: this.openAIConfig.models.transcribeModel,
        retries: 0,
      });
      text = result.text.trim();
    } catch {
      throw new BadGatewayException('Unable to transcribe audio');
    }
    if (!text) throw new BadRequestException('No speech was detected');
    if (text.length > 4000)
      throw new BadRequestException('Transcript is too long');
    return text;
  }
  async speak(answer: string) {
    const client = this.client();
    const controller = new AbortController();
    const startedTotal = performance.now();
    let chunksStarted = 0;
    let chunksCompleted = 0;
    let requestId: string | null = null;
    const metadata = () => ({
      model: this.openAIConfig.models.ttsModel,
      voice: this.openAIConfig.models.voice,
      inputLength: answer.length,
      chunkCount: Math.ceil(answer.length / 2000),
      chunksStarted,
      chunksCompleted,
      timeoutMs: TTS_TIMEOUT_MS,
      retries: 0,
    });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TtsTimeoutError());
        controller.abort();
      }, TTS_TIMEOUT_MS);
      timer.unref();
    });
    timing('tts_request', metadata());
    const synthesize = async () => {
      const parts: Buffer[] = [];
      for (let start = 0; start < answer.length; start += 2000) {
        controller.signal.throwIfAborted();
        const started = performance.now();
        chunksStarted++;
        const response = await client.audio.speech.create(
          {
            model: this.openAIConfig.models.ttsModel,
            voice: this.openAIConfig.models.voice,
            input: answer.slice(start, start + 2000),
            response_format: 'mp3',
          },
          { signal: controller.signal, timeout: TTS_TIMEOUT_MS, maxRetries: 0 },
        );
        requestId = response.headers?.get('x-request-id') ?? null;
        controller.signal.throwIfAborted();
        const bytes = await response.arrayBuffer();
        controller.signal.throwIfAborted();
        parts.push(Buffer.from(bytes));
        chunksCompleted++;
        timing('tts_chunk', {
          ...metadata(),
          durationMs: performance.now() - started,
          chunk: parts.length,
          characters: answer.slice(start, start + 2000).length,
          status: response.status,
          openAIRequestId: requestId,
        });
      }
      const audio = Buffer.concat(parts);
      if (!audio.length) throw new Error('Empty speech');
      return audio.toString('base64');
    };
    try {
      // One deadline includes all chunks and their body reads. The race also
      // bounds non-cooperative transports; abort stops supported SDK/network I/O.
      return await Promise.race([synthesize(), deadline]);
    } catch (error) {
      const info = error as {
        name?: unknown;
        status?: unknown;
        code?: unknown;
        type?: unknown;
        message?: unknown;
        request_id?: unknown;
        error?: { code?: unknown; type?: unknown; message?: unknown };
      } | null;
      const safe = (value: unknown) => {
        if (typeof value !== 'string') return undefined;
        let text = value;
        for (const secret of [
          process.env.OPENAI_API_KEY,
          answer,
          ...Array.from(
            { length: Math.ceil(answer.length / 2000) },
            (_, index) => answer.slice(index * 2000, (index + 1) * 2000),
          ),
        ]) {
          if (secret) text = text.split(secret).join('[redacted]');
        }
        return text
          .replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, '[redacted]')
          .slice(0, 500);
      };
      const timedOut =
        controller.signal.aborted ||
        error instanceof TtsTimeoutError ||
        info?.name === 'APIConnectionTimeoutError';
      if (timedOut) controller.abort();
      timing(timedOut ? 'tts_total:timeout' : 'tts_total:error', {
        ...metadata(),
        durationMs: performance.now() - startedTotal,
        errorName: safe(info?.name),
        httpStatus: typeof info?.status === 'number' ? info.status : undefined,
        errorCode: safe(info?.code ?? info?.error?.code),
        errorType: safe(info?.type ?? info?.error?.type),
        errorMessage: safe(info?.error?.message ?? info?.message),
        openAIRequestId: safe(info?.request_id ?? requestId),
      });
      if (timedOut) throw new TtsTimeoutError();
      throw new BadGatewayException('Unable to generate speech');
    } finally {
      clearTimeout(timer!);
    }
  }
}
