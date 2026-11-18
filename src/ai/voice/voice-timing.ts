import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const context = new AsyncLocalStorage<{
  id: string;
  started: number;
  rounds: number;
  conversationId?: string;
  clientRequestId?: string;
  voiceTurn?: number;
  port?: number;
  url?: string;
}>();
export function timing(event: string, details: Record<string, unknown> = {}) {
  const current = context.getStore();
  if (process.env.NODE_ENV !== 'development' || !current) return;
  console.debug(
    JSON.stringify({
      event: `voice.${event}`,
      marker: '[VOICE BACKEND]',
      requestId: current.id,
      clientRequestId: current.clientRequestId,
      voiceTurn: current.voiceTurn,
      conversationId: current.conversationId ?? null,
      pid: process.pid,
      port: current.port,
      url: current.url,
      timestamp: new Date().toISOString(),
      elapsedMs: performance.now() - current.started,
      ...details,
    }),
  );
}
export function voiceConversation(conversationId: string | undefined) {
  const current = context.getStore();
  if (current) current.conversationId = conversationId;
}
export function aiRound(details: Record<string, unknown>) {
  const current = context.getStore();
  if (current) current.rounds++;
  timing('ai_round', { round: current?.rounds, ...details });
}
@Injectable()
export class VoiceTimingInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    if (process.env.NODE_ENV !== 'development') return next.handle();
    const request = _context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      socket: { localPort?: number };
      originalUrl: string;
    }>();
    const clientId = request.headers['x-voice-request-id'];
    const turn = request.headers['x-voice-turn'];
    return new Observable((subscriber) =>
      context.run(
        {
          id: randomUUID(),
          started: performance.now(),
          rounds: 0,
          clientRequestId:
            typeof clientId === 'string' && /^[a-f0-9-]{36}$/i.test(clientId)
              ? clientId
              : undefined,
          voiceTurn:
            typeof turn === 'string' && /^[1-9]\d{0,8}$/.test(turn)
              ? Number(turn)
              : undefined,
          port: request.socket.localPort,
          url: request.originalUrl.split('?')[0],
        },
        () => {
          timing('request_started');
          const subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error) => {
              timing('backend_total', {
                totalDurationMs:
                  performance.now() - context.getStore()!.started,
                status: 'error',
                toolCallRounds: context.getStore()?.rounds,
              });
              subscriber.error(error);
            },
            complete: () => {
              timing('backend_total', {
                totalDurationMs:
                  performance.now() - context.getStore()!.started,
                status: 'success',
                toolCallRounds: context.getStore()?.rounds,
              });
              subscriber.complete();
            },
          });
          return () => subscription.unsubscribe();
        },
      ),
    );
  }
}
export async function timeStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  timing(`${stage}:start`);
  const slow =
    context.getStore() && process.env.NODE_ENV === 'development'
      ? setTimeout(
          () =>
            timing(`${stage}:slow`, {
              durationMs: performance.now() - started,
              thresholdMs: 5000,
            }),
          5000,
        )
      : undefined;
  slow?.unref();
  let status = 'success';
  try {
    return await operation();
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    clearTimeout(slow);
    timing(stage, { durationMs: performance.now() - started, status });
    timing(`${stage}:end`, { durationMs: performance.now() - started, status });
  }
}
