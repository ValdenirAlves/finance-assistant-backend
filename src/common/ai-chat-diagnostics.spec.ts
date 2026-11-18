import {
  withChatDiagnostics,
  diagnostic,
  diagnosticRound,
  diagnosticConversation,
} from './ai-chat-diagnostics.js';
describe('temporary exact-path development diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('records a bounded round count without financial text', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AI_CHAT_TIMING', '1');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await withChatDiagnostics(
      'Tem algo importante nas minhas finanças este mês?',
      async () => {
        diagnosticConversation('existing-conversation');
        diagnosticRound();
        diagnostic('sample', { durationMs: 1 });
        return 'private financial response';
      },
      {
        conversationId: 'existing-conversation',
        requestUrl: 'http://localhost:3000/ai/chat',
        backendPort: 3000,
      },
    );
    expect(
      log.mock.calls.map((call) => JSON.parse(call[0] as string)).at(-1),
    ).toMatchObject({
      event: 'ai_chat.request_total',
      toolCallRounds: 1,
      conversationId: 'existing-conversation',
      processPid: process.pid,
      requestUrl: 'http://localhost:3000/ai/chat',
      backendPort: 3000,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'private financial response',
    );
  });
  it('emits nothing in production even with flag set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_CHAT_TIMING', '1');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await withChatDiagnostics(
      'Tem algo importante nas minhas finanças este mês?',
      async () => diagnostic('sample'),
    );
    expect(log).not.toHaveBeenCalled();
  });
});
