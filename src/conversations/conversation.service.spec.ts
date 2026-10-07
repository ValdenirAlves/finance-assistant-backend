import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ConversationService,
  CONVERSATION_HISTORY_LIMIT,
} from './conversation.service.js';

describe('ConversationService', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    conversation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversationMessage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  let service: ConversationService;
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.conversation.findUnique.mockResolvedValue({ id });
    prisma.conversation.update.mockResolvedValue({ updatedAt: new Date() });
    prisma.conversationMessage.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    service = new ConversationService(prisma as unknown as PrismaService);
  });

  it('creates a conversation', async () => {
    prisma.conversation.create.mockResolvedValue({ id });
    expect(await service.create()).toEqual({ id });
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: {},
      select: { id: true },
    });
  });

  it('stores only user and assistant conversational content in one transaction', async () => {
    await service.saveTurn(id, 'This month?', 'EUR 78.50');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    const data = prisma.conversationMessage.createMany.mock.calls[0][0].data;
    expect(data).toEqual([
      {
        conversationId: id,
        role: 'USER',
        content: 'This month?',
        createdAt: expect.any(Date),
      },
      {
        conversationId: id,
        role: 'ASSISTANT',
        content: 'EUR 78.50',
        createdAt: expect.any(Date),
      },
    ]);
    expect(data[1].createdAt.getTime()).toBeGreaterThan(
      data[0].createdAt.getTime(),
    );
  });

  it('orders completed turns after existing messages', async () => {
    const previous = new Date(Date.now() + 1000);
    prisma.conversationMessage.findFirst.mockResolvedValue({
      createdAt: previous,
    });
    await service.saveTurn(id, 'follow-up', 'answer');
    expect(
      prisma.conversationMessage.createMany.mock.calls[0][0].data[0].createdAt.getTime(),
    ).toBeGreaterThan(previous.getTime());
  });

  it('loads only the 20 most recent messages and returns chronological order', async () => {
    const recent = Array.from(
      { length: CONVERSATION_HISTORY_LIMIT },
      (_, index) => ({ role: 'USER', content: String(30 - index) }),
    );
    prisma.conversationMessage.findMany.mockResolvedValue(recent);
    expect(await service.recentMessages(id)).toEqual([...recent].reverse());
    expect(prisma.conversationMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { role: true, content: true },
    });
  });

  it('returns not found for an unknown conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null);
    await expect(service.recentMessages(id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.conversationMessage.findMany).not.toHaveBeenCalled();
  });

  it('sanitizes database failures when loading, creating or saving', async () => {
    prisma.conversation.create.mockRejectedValue(
      new Error('private database details'),
    );
    prisma.conversation.findUnique.mockRejectedValue(
      new Error('private database details'),
    );
    prisma.$transaction.mockRejectedValue(
      new Error('private database details'),
    );
    await expect(service.create()).rejects.toThrow(
      'Conversation storage is unavailable',
    );
    await expect(service.recentMessages(id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.saveTurn(id, 'user', 'answer')).rejects.toThrow(
      'Conversation storage is unavailable',
    );
  });
});
