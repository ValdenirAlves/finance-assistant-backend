import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export const CONVERSATION_HISTORY_LIMIT = 20;

@Injectable()
export class ConversationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create() {
    try {
      return await this.prisma.conversation.create({
        data: {},
        select: { id: true },
      });
    } catch {
      throw new ServiceUnavailableException(
        'Conversation storage is unavailable',
      );
    }
  }

  async recentMessages(conversationId: string) {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      const messages = await this.prisma.conversationMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CONVERSATION_HISTORY_LIMIT,
        select: { role: true, content: true },
      });
      return [...messages].reverse();
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        'Conversation storage is unavailable',
      );
    }
  }

  async saveTurn(
    conversationId: string,
    userContent: string,
    assistantContent: string,
  ) {
    try {
      await this.prisma.$transaction(async (transaction) => {
        // Updating the parent serializes completed turns on this conversation.
        const conversation = await transaction.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
          select: { updatedAt: true },
        });
        const lastMessage = await transaction.conversationMessage.findFirst({
          where: { conversationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true },
        });
        const userDate = new Date(
          Math.max(
            Date.now(),
            conversation.updatedAt.getTime(),
            (lastMessage?.createdAt.getTime() ?? 0) + 1,
          ),
        );
        await transaction.conversationMessage.createMany({
          data: [
            {
              conversationId,
              role: 'USER',
              content: userContent,
              createdAt: userDate,
            },
            {
              conversationId,
              role: 'ASSISTANT',
              content: assistantContent,
              createdAt: new Date(userDate.getTime() + 1),
            },
          ],
        });
      });
    } catch {
      throw new ServiceUnavailableException(
        'Conversation storage is unavailable',
      );
    }
  }
}
