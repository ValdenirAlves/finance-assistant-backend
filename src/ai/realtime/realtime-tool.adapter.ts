import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AiService } from '../ai.service.js';

export const FINANCE_TURN_TOOL = {
  type: 'function' as const,
  name: 'finance_turn',
  description:
    'Process the current user utterance through the authoritative backend. All financial reads, drafts and explicit confirmation are handled there. Never reconstruct or replace the user message.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    required: [],
  },
};
@Injectable()
export class RealtimeToolAdapter {
  constructor(@Inject(AiService) private readonly ai: AiService) {}
  execute(
    name: string,
    json: string,
    transcript: string,
    conversationId: string,
  ) {
    let args: unknown;
    try {
      args = JSON.parse(json);
    } catch {
      throw new BadRequestException('Invalid realtime tool arguments');
    }
    if (
      name !== 'finance_turn' ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).length ||
      !transcript.trim() ||
      transcript.length > 4000
    )
      throw new BadRequestException('Invalid realtime tool');
    // Only the server-observed utterance can authorize an operation. No tool
    // arguments, client-provided confirmation flags or generated prose are used.
    return this.ai.chat({ message: transcript, conversationId });
  }
}
