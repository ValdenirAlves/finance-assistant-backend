import { Inject, Injectable } from '@nestjs/common';
import { AiService } from '../ai.service.js';
import { ConversationService } from '../../conversations/conversation.service.js';
import { LiveTurnQueue } from './live-turn-queue.js';
import type { LiveTurnControl } from './live-turn-control.js';

export type LiveFinanceDelegationRequest = {
  sessionId: string;
  conversationId: string;
  delegationId: string;
  userTurn: string;
};

@Injectable()
export class LiveFinanceAdapter {
  private readonly turns = new LiveTurnQueue();
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(ConversationService)
    private readonly conversations: ConversationService,
  ) {}

  async openConversation(id?: string) {
    if (id) {
      await this.conversations.recentMessages(id);
      return id;
    }
    return (await this.conversations.create()).id;
  }

  execute(
    request: LiveFinanceDelegationRequest,
    signal: AbortSignal,
    control?: LiveTurnControl,
  ) {
    // Only server-observed, settled transcripts enter the restricted agent path.
    control?.onOperation('INTERPRETING');
    let waited = false;
    return this.turns.enqueue(
      request.conversationId,
      signal,
      async (isLatest, depth) => {
        const scoped = control
          ? {
              ...control,
              confirmationAllowed: control.confirmationAllowed && !waited,
              isCurrent: () => control.isCurrent() && isLatest(),
              log: (
                event: string,
                fields: { queueDepth: number; pendingRevision: number | null },
              ) => control.log?.(event, { ...fields, queueDepth: depth() }),
            }
          : undefined;
        const input = {
          message: request.userTurn,
          conversationId: request.conversationId,
        };
        const result = scoped
          ? await this.ai.liveTurn(input, signal, scoped)
          : await this.ai.liveTurn(input, signal);
        // Pending-only updates may complete in order, but an obsolete reply must
        // never be spoken or reused as the result of the newer delegation.
        if (scoped && !scoped.isCurrent())
          throw new DOMException('Superseded Live result', 'AbortError');
        return result;
      },
      (depth) => {
        waited = depth > 1;
        control?.log?.('write_queued', {
          queueDepth: depth,
          pendingRevision: null,
        });
      },
    );
  }
}
