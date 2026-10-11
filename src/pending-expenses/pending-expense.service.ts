import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { CreateExpenseDto } from '../expenses/dto/create-expense.dto.js';
import type { PendingExpense, Prisma } from '../generated/prisma/client.js';

@Injectable()
export class PendingExpenseService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
  ) {}

  async get(conversationId: string) {
    try {
      return await this.prisma.pendingExpense.findUnique({
        where: { conversationId },
      });
    } catch {
      throw new ServiceUnavailableException(
        'Pending expense storage is unavailable',
      );
    }
  }

  async prepare(
    conversationId: string,
    input: CreateExpenseDto,
    expectedRevision: number | null,
  ) {
    const data = this.expenses.validateCreate(input);
    return this.locked(conversationId, async (tx) => {
      const current = await tx.pendingExpense.findUnique({
        where: { conversationId },
      });
      if ((current?.revision ?? null) !== expectedRevision)
        throw new ConflictException('Pending expense changed; review it again');
      return tx.pendingExpense.upsert({
        where: { conversationId },
        create: { conversationId, ...data },
        update: {
          ...data,
          status: 'PENDING',
          revision: { increment: 1 },
          confirmationRequested: false,
          expenseId: null,
        },
      });
    });
  }

  async requestConfirmation(conversationId: string, revision: number) {
    return this.locked(conversationId, async (tx) => {
      const result = await tx.pendingExpense.updateMany({
        where: { conversationId, revision, status: 'PENDING' },
        data: { confirmationRequested: true },
      });
      if (result.count !== 1)
        throw new ConflictException('Pending expense changed; review it again');
    });
  }

  async suspendConfirmation(conversationId: string, revision: number) {
    return this.locked(conversationId, async (tx) => {
      await tx.pendingExpense.updateMany({
        where: { conversationId, revision, status: 'PENDING' },
        data: { confirmationRequested: false },
      });
    });
  }

  async confirm(conversationId: string, revision: number) {
    return this.locked(conversationId, async (tx) => {
      const pending = await tx.pendingExpense.findUnique({
        where: { conversationId },
      });
      if (!pending || pending.revision !== revision)
        throw new ConflictException(
          'No matching pending expense; review it again',
        );
      if (pending.status === 'CONFIRMED' && pending.expenseId) {
        const expense = await tx.expense.findUniqueOrThrow({
          where: { id: pending.expenseId },
        });
        return { ...expense, amount: expense.amount.toFixed(4) };
      }
      if (pending.status !== 'PENDING')
        throw new BadRequestException('Pending expense was cancelled');
      if (!pending.confirmationRequested)
        throw new BadRequestException(
          'Review the pending expense and confirm explicitly',
        );
      const expense = await this.expenses.create(
        {
          amount: pending.amount.toFixed(2),
          currency: pending.currency,
          merchant: pending.merchant,
          description: pending.description,
          transactionDate: pending.transactionDate.toISOString(),
        },
        tx,
      );
      await tx.pendingExpense.update({
        where: { conversationId },
        data: {
          status: 'CONFIRMED',
          expenseId: expense.id,
          confirmationRequested: false,
        },
      });
      return expense;
    });
  }

  async cancel(conversationId: string, revision: number) {
    return this.locked(conversationId, async (tx) => {
      const result = await tx.pendingExpense.updateMany({
        where: { conversationId, revision, status: 'PENDING' },
        data: { status: 'CANCELLED', confirmationRequested: false },
      });
      return result.count === 1;
    });
  }

  summary(pending: PendingExpense) {
    return {
      amount: pending.amount.toFixed(2),
      currency: pending.currency,
      merchant: pending.merchant,
      description: pending.description,
      transactionDate: pending.transactionDate.toISOString(),
      status: pending.status,
      revision: pending.revision,
    };
  }

  private async locked<T>(
    conversationId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Parent row lock serializes preparation, correction, cancellation and confirmation.
        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        return operation(tx);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Unable to save pending expense; retry safely',
      );
    }
  }
}
