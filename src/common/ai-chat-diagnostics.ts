import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage<{
  conversationId: string | null;
  requestUrl?: string;
  backendPort?: number;
  id: string;
  started: number;
  rounds: number;
  queries: number;
}>();
export function diagnosticsEnabled() {
  return (
    process.env.NODE_ENV === 'development' && process.env.AI_CHAT_TIMING === '1'
  );
}
export function isExactInsightsQuestion(message: unknown) {
  return (
    typeof message === 'string' &&
    message
      .trim()
      .toLowerCase()
      .replace(/[?!.]+$/, '') ===
      'tem algo importante nas minhas finanças este mês'
  );
}
export function diagnostic(
  event: string,
  details: Record<string, unknown> = {},
) {
  const current = context.getStore();
  if (!diagnosticsEnabled() || !current) return;
  console.debug(
    JSON.stringify({
      event: `ai_chat.${event}`,
      requestId: current.id,
      conversationId: current.conversationId,
      processPid: process.pid,
      requestUrl: current.requestUrl,
      backendPort: current.backendPort,
      elapsedMs: performance.now() - current.started,
      ...details,
    }),
  );
}
export interface ChatRequestIdentity {
  requestUrl?: string;
  backendPort?: number;
  conversationId?: string;
}
export function diagnosticConversation(conversationId: string) {
  const current = context.getStore();
  if (current) current.conversationId = conversationId;
}
export async function measureDiagnostic<T>(
  stage: string,
  operation: () => Promise<T>,
  details: Record<string, unknown> = {},
): Promise<T> {
  if (!context.getStore()) return operation();
  const started = performance.now();
  diagnostic(`${stage}.start`, details);
  const slow = setTimeout(
    () =>
      diagnostic(`${stage}.slow`, {
        ...details,
        durationMs: performance.now() - started,
        thresholdMs: 5000,
      }),
    5000,
  );
  slow.unref();
  let status = 'success';
  try {
    return await operation();
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    clearTimeout(slow);
    diagnostic(stage, {
      ...details,
      durationMs: performance.now() - started,
      status,
    });
  }
}
export function diagnosticRound() {
  const current = context.getStore();
  if (current) current.rounds++;
  return current?.rounds;
}
export function diagnosticQuery(durationMs: number, operation: string) {
  const current = context.getStore();
  if (current) current.queries++;
  diagnostic('database_query', {
    durationMs,
    operation,
    slow: durationMs >= 1000,
  });
}
export async function withChatDiagnostics<T>(
  message: string,
  operation: () => Promise<T>,
  identity: ChatRequestIdentity = {},
): Promise<T> {
  const exact = isExactInsightsQuestion(message);
  if (!diagnosticsEnabled() || !exact) return operation();
  return context.run(
    {
      id: randomUUID(),
      started: performance.now(),
      rounds: 0,
      queries: 0,
      conversationId: identity.conversationId ?? null,
      requestUrl: identity.requestUrl,
      backendPort: identity.backendPort,
    },
    async () => {
      diagnostic('request_start');
      let status = 'success';
      try {
        return await operation();
      } catch (error) {
        status = 'error';
        throw error;
      } finally {
        const current = context.getStore()!;
        diagnostic('request_total', {
          durationMs: performance.now() - current.started,
          status,
          toolCallRounds: current.rounds,
          databaseQueries: current.queries,
        });
      }
    },
  );
}
