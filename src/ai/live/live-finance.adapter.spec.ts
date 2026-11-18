import { LiveFinanceAdapter } from './live-finance.adapter.js';
import type { AiService } from '../ai.service.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
describe('Live finance adapter', () => {
  it('validates an existing persisted conversation and creates one only if absent', async () => {
    const conversations = {
      recentMessages: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'new' }),
    };
    const adapter = new LiveFinanceAdapter(
      {} as AiService,
      conversations as unknown as ConversationService,
    );
    expect(await adapter.openConversation('existing')).toBe('existing');
    expect(conversations.recentMessages).toHaveBeenCalledWith('existing');
    expect(conversations.create).not.toHaveBeenCalled();
    expect(await adapter.openConversation()).toBe('new');
  });
  it('uses only the restricted entry, never chat, Realtime or reconstructed prose', async () => {
    const ai = {
      liveTurn: vi.fn().mockResolvedValue({ type: 'CONFIRMATION_REQUIRED' }),
      chat: vi.fn(),
    };
    const adapter = new LiveFinanceAdapter(
      ai as unknown as AiService,
      {} as ConversationService,
    );
    const signal = new AbortController().signal;
    await adapter.execute(
      {
        sessionId: 's',
        conversationId: 'c',
        delegationId: 'd',
        userTurn: 'E com pets?',
      },
      signal,
    );
    expect(ai.liveTurn).toHaveBeenCalledExactlyOnceWith(
      { message: 'E com pets?', conversationId: 'c' },
      signal,
    );
    expect(ai.chat).not.toHaveBeenCalled();
  });
});
