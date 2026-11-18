import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { BankAccount } from '../generated/prisma/client.js';
import { BalanceInputDto, BalanceQueryDto } from './bank-balance.dto.js';
import { BankBalanceIntentDto } from './bank-balance-intent.dto.js';
import type { BankBalanceWriteResult } from './bank-balance-intent.dto.js';

@Injectable()
export class BankAccountsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  private validate<T extends object>(value: T) {
    if (
      validateSync(value, { whitelist: true, forbidNonWhitelisted: true })
        .length
    )
      throw new BadRequestException('Invalid bank balance arguments');
    return value;
  }
  private serialize(row: BankAccount) {
    return { ...row, currentBalance: row.currentBalance.toFixed(2) };
  }
  async findAll(input: BalanceQueryDto = {}) {
    const dto = this.validate(plainToInstance(BalanceQueryDto, input));
    const rows = await this.prisma.bankAccount.findMany({
      where: {
        owner: 'SELF',
        ...(dto.currency ? { currency: dto.currency } : {}),
        ...(dto.account
          ? {
              name: {
                equals: dto.account.replace(/[\\%_]/g, '\\$&'),
                mode: 'insensitive' as const,
              },
            }
          : {}),
      },
      orderBy: { currency: 'asc' },
    });
    return rows.map((row) => this.serialize(row));
  }
  async findById(id: string) {
    const row = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Bank account not found');
    return this.serialize(row);
  }
  getPending(conversationId: string) {
    return this.prisma.pendingBankBalance.findUnique({
      where: { conversationId },
    });
  }
  createConversation() {
    return this.prisma.conversation.create({ data: {}, select: { id: true } });
  }
  private locked<T>(
    conversationId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      signal?.throwIfAborted();
      const result = await operation(tx);
      signal?.throwIfAborted();
      return result;
    });
  }
  async prepare(
    conversationId: string,
    input: BalanceInputDto,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ) {
    const dto = this.validate(plainToInstance(BalanceInputDto, input));
    const data = {
      currency: dto.currency,
      currentBalance: new Prisma.Decimal(dto.currentBalance),
      name: dto.name?.trim() ?? null,
    };
    if (data.name === '')
      throw new BadRequestException('Account name cannot be blank');
    return this.locked(
      conversationId,
      async (tx) => {
        const current = await tx.pendingBankBalance.findUnique({
          where: { conversationId },
        });
        if ((current?.revision ?? null) !== expectedRevision)
          throw new ConflictException('Balance draft changed; review it again');
        await tx.pendingExpense.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        await tx.pendingBudget.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        return tx.pendingBankBalance.upsert({
          where: { conversationId },
          create: { conversationId, ...data },
          update: {
            ...data,
            revision: { increment: 1 },
            status: 'PENDING',
            confirmationRequested: false,
            accountId: null,
          },
        });
      },
      signal,
    );
  }
  async arm(conversationId: string, revision: number, signal?: AbortSignal) {
    return this.locked(
      conversationId,
      async (tx) => {
        const result = await tx.pendingBankBalance.updateMany({
          where: { conversationId, revision, status: 'PENDING' },
          data: { confirmationRequested: true },
        });
        if (result.count !== 1)
          throw new ConflictException('Balance draft changed');
      },
      signal,
    );
  }
  async cancel(conversationId: string, revision: number, signal?: AbortSignal) {
    return this.locked(
      conversationId,
      async (tx) => {
        const result = await tx.pendingBankBalance.updateMany({
          where: { conversationId, revision, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        if (result.count !== 1)
          throw new ConflictException('Balance draft is not active');
      },
      signal,
    );
  }
  async suspend(conversationId: string) {
    await this.prisma.pendingBankBalance.updateMany({
      where: { conversationId, status: 'PENDING' },
      data: { confirmationRequested: false },
    });
  }
  async confirm(
    conversationId: string,
    revision: number,
    signal?: AbortSignal,
  ) {
    return this.locked(
      conversationId,
      async (tx) => {
        const row = await tx.pendingBankBalance.findUnique({
          where: { conversationId },
        });
        if (!row || row.revision !== revision)
          throw new ConflictException('Balance draft changed');
        if (row.status === 'CONFIRMED') return { status: 'CONFIRMED' as const };
        if (row.status !== 'PENDING' || !row.confirmationRequested)
          throw new BadRequestException(
            'Review and explicitly confirm the balance first',
          );
        const existing = await tx.bankAccount.findUnique({
          where: { owner_currency: { owner: 'SELF', currency: row.currency } },
        });
        const account = await tx.bankAccount.upsert({
          where: { owner_currency: { owner: 'SELF', currency: row.currency } },
          create: {
            owner: 'SELF',
            currency: row.currency,
            name: row.name ?? 'Personal',
            currentBalance: row.currentBalance,
          },
          update: {
            name: row.name ?? existing?.name ?? 'Personal',
            currentBalance: row.currentBalance,
          },
        });
        await tx.pendingBankBalance.update({
          where: { conversationId },
          data: {
            status: 'CONFIRMED',
            confirmationRequested: false,
            accountId: account.id,
          },
        });
        return { status: 'CONFIRMED' as const };
      },
      signal,
    );
  }

  // Semantic Live adapter over the same validated preparation/confirmation flow.
  async applyIntent(
    conversationId: string,
    input: BankBalanceIntentDto,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ): Promise<BankBalanceWriteResult> {
    const intent = this.validate(plainToInstance(BankBalanceIntentDto, input));
    signal?.throwIfAborted();
    const current = await this.getPending(conversationId);
    if ((current?.revision ?? null) !== expectedRevision)
      throw new ConflictException('Balance draft changed; review it again');
    if (!['CREATE', 'PATCH'].includes(intent.action) && intent.changes.length)
      return {
        type: 'WRITE_REJECTED',
        reason: 'Review changes separately before confirming',
      };

    if (intent.action === 'CREATE' || intent.action === 'PATCH') {
      if (
        intent.action === 'PATCH' &&
        (current?.status !== 'PENDING' || !intent.changes.length)
      )
        return {
          type: 'WRITE_REJECTED',
          reason: 'No active balance draft to patch',
        };
      const changes = Object.fromEntries(
        intent.changes.map(({ field, value }) => [field, value]),
      );
      const fields =
        intent.action === 'PATCH' && current
          ? {
              currentBalance: current.currentBalance.toFixed(2),
              currency: current.currency,
              name: current.name,
              ...changes,
            }
          : changes;
      const missingFields = ['currentBalance', 'currency'].filter(
        (field) => fields[field] === undefined,
      );
      if (missingFields.length) {
        if (current?.status === 'PENDING') await this.suspend(conversationId);
        return {
          type: 'MISSING_INFORMATION',
          domain: 'BANK_BALANCE',
          missingFields,
        };
      }
      const draft = await this.prepare(
        conversationId,
        fields as unknown as BalanceInputDto,
        expectedRevision,
        signal,
      );
      await this.arm(conversationId, draft.revision, signal);
      return this.balanceReview(draft);
    }
    if (!current || intent.action === 'NO_ACTION')
      return {
        type: 'WRITE_REJECTED',
        reason: 'No explicit active balance action',
      };
    if (intent.action === 'CANCEL') {
      if (current.status === 'PENDING')
        await this.cancel(conversationId, current.revision, signal);
      return current.status === 'CONFIRMED'
        ? { type: 'WRITE_REJECTED', reason: 'Balance update already saved' }
        : { type: 'BANK_BALANCE_CANCELLED', pendingRevision: current.revision };
    }
    if (current.status === 'CANCELLED')
      return { type: 'WRITE_REJECTED', reason: 'Balance draft cancelled' };
    if (current.status === 'PENDING' && !current.confirmationRequested) {
      // An intervening read/clarification requires a fresh review, then new consent.
      await this.arm(conversationId, current.revision, signal);
      return this.balanceReview(current);
    }
    await this.confirm(conversationId, current.revision, signal);
    return { type: 'BANK_BALANCE_SAVED', pendingRevision: current.revision };
  }

  private balanceReview(row: {
    revision: number;
    currentBalance: Prisma.Decimal;
    currency: BankAccount['currency'];
    name?: string | null;
  }): BankBalanceWriteResult {
    return {
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
      pendingRevision: row.revision,
      balanceDraftDisclosureAllowed: true,
      draft: {
        currentBalance: row.currentBalance.toFixed(2),
        currency: row.currency,
        name: row.name ?? null,
      },
    };
  }
}
