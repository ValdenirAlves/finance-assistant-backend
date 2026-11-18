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
import { Prisma as PrismaValues } from '../generated/prisma/client.js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ExpenseIntentDto } from './expense-intent.dto.js';

export type ExpenseWriteResult = {
  type:
    | 'MISSING_INFORMATION'
    | 'CONFIRMATION_REQUIRED'
    | 'DUPLICATE_CONFIRMATION_REQUIRED'
    | 'EXPENSE_SAVED'
    | 'EXPENSE_CANCELLED'
    | 'EXPENSE_STATUS'
    | 'WRITE_REJECTED';
  pendingRevision?: number;
  draft?: ReturnType<PendingExpenseService['summary']>;
  missingFields?: string[];
  expenseId?: string;
  reason?: string;
};

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
    this.expenses.validateCreate(input);
    return this.prepareDraft(conversationId, input, expectedRevision);
  }

  private validateDraft(input: Partial<CreateExpenseDto>) {
    const dto = plainToInstance(CreateExpenseDto, input);
    if (
      validateSync(dto, {
        skipMissingProperties: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }).length
    )
      throw new BadRequestException('Invalid expense draft');
    const amount =
      dto.amount == null ? null : new PrismaValues.Decimal(dto.amount);
    if (amount && !amount.gt('0'))
      throw new BadRequestException('amount must be greater than 0');
    return {
      amount,
      currency: dto.currency ?? null,
      transactionDate:
        dto.transactionDate == null ? null : new Date(dto.transactionDate),
      payer: dto.payer ?? null,
      paymentMethod: dto.paymentMethod ?? null,
      category: dto.category ?? ('OTHER' as const),
      merchant: dto.merchant?.trim() || null,
      description: dto.description ?? null,
    };
  }

  async prepareDraft(
    conversationId: string,
    input: Partial<CreateExpenseDto>,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ) {
    const data = this.validateDraft(input);
    data.category =
      (await this.expenses.categoryFor(input.merchant)) ?? data.category;
    return this.locked(
      conversationId,
      async (tx) => {
        const current = await tx.pendingExpense.findUnique({
          where: { conversationId },
        });
        if ((current?.revision ?? null) !== expectedRevision)
          throw new ConflictException(
            'Pending expense changed; review it again',
          );
        await tx.pendingBudget.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        await tx.pendingBankBalance.updateMany({
          where: { conversationId, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        return tx.pendingExpense.upsert({
          where: { conversationId },
          create: { conversationId, ...data },
          update: {
            ...data,
            status: 'PENDING',
            revision: { increment: 1 },
            confirmationRequested: false,
            duplicateReviewRequired: false,
            expenseId: null,
          },
        });
      },
      signal,
    );
  }

  async requestConfirmation(
    conversationId: string,
    revision: number,
    signal?: AbortSignal,
  ) {
    return this.locked(
      conversationId,
      async (tx) => {
        const current = await tx.pendingExpense.findUnique({
          where: { conversationId },
        });
        if (!current || this.missingFields(current).length)
          throw new ConflictException(
            'Resolve required expense fields before confirmation',
          );
        const result = await tx.pendingExpense.updateMany({
          where: {
            conversationId,
            revision,
            status: 'PENDING',
            payer: { not: null },
          },
          data: { confirmationRequested: true },
        });
        if (result.count !== 1)
          throw new ConflictException(
            'Pending expense changed; review it again',
          );
      },
      signal,
    );
  }

  async patch(
    conversationId: string,
    changes: Partial<CreateExpenseDto>,
    expectedRevision: number,
  ) {
    const supplied = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    if (!Object.keys(supplied).length)
      throw new BadRequestException('Provide at least one draft change');
    for (const [field, value] of Object.entries(supplied)) {
      if (
        value === null &&
        !['merchant', 'description', 'payer', 'paymentMethod'].includes(field)
      )
        throw new BadRequestException(
          'Required expense fields cannot be cleared',
        );
    }
    return this.patchDraft(conversationId, supplied, expectedRevision);
  }

  async patchDraft(
    conversationId: string,
    supplied: Partial<CreateExpenseDto>,
    expectedRevision: number,
    signal?: AbortSignal,
  ) {
    return this.locked(
      conversationId,
      async (tx) => {
        const current = await tx.pendingExpense.findUnique({
          where: { conversationId },
        });
        if (
          !current ||
          current.status !== 'PENDING' ||
          current.revision !== expectedRevision
        )
          throw new ConflictException(
            'Pending expense changed; review it again',
          );
        // Merge only supplied fields under the same conversation lock used by
        // confirmation. Validation rejects unknown fields and null required values.
        const data = this.validateDraft({
          amount: current.amount?.toFixed(2),
          currency: current.currency ?? undefined,
          merchant: current.merchant,
          description: current.description,
          transactionDate: current.transactionDate?.toISOString(),
          category: current.category,
          payer: current.payer,
          paymentMethod: current.paymentMethod,
          ...supplied,
        });
        return tx.pendingExpense.update({
          where: { conversationId },
          data: {
            ...data,
            revision: { increment: 1 },
            confirmationRequested: false,
            duplicateReviewRequired: false,
            expenseId: null,
          },
        });
      },
      signal,
    );
  }

  async suspendConfirmation(conversationId: string, revision: number) {
    return this.locked(conversationId, async (tx) => {
      await tx.pendingExpense.updateMany({
        where: { conversationId, revision, status: 'PENDING' },
        data: { confirmationRequested: false },
      });
    });
  }

  async confirm(
    conversationId: string,
    revision: number,
    duplicateOverride = false,
    signal?: AbortSignal,
  ) {
    return this.locked(
      conversationId,
      async (tx) => {
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
          return { ...expense, amount: expense.amount.toFixed(2) };
        }
        if (pending.status !== 'PENDING')
          throw new BadRequestException('Pending expense was cancelled');
        if (!pending.confirmationRequested)
          throw new BadRequestException(
            'Review the pending expense and confirm explicitly',
          );
        if (!pending.payer)
          throw new BadRequestException('Resolve payer before confirming');
        if (this.missingFields(pending).length)
          throw new BadRequestException(
            'Resolve required expense fields before confirming',
          );
        const input = {
          payer: pending.payer,
          paymentMethod: pending.paymentMethod,
          category: pending.category,
          amount: pending.amount!.toFixed(2),
          currency: pending.currency!,
          merchant: pending.merchant,
          description: pending.description,
          transactionDate: pending.transactionDate!.toISOString(),
        };
        if (duplicateOverride && !pending.duplicateReviewRequired)
          throw new BadRequestException('No duplicate review is active');
        if (pending.duplicateReviewRequired && !duplicateOverride) return null;
        if (
          !duplicateOverride &&
          (await this.expenses.findPotentialDuplicate(input, tx))
        ) {
          await tx.pendingExpense.update({
            where: { conversationId },
            data: { duplicateReviewRequired: true },
          });
          return null;
        }
        const expense = await this.expenses.create(input, tx);
        await this.expenses.learnCategory(
          pending.merchant,
          pending.category,
          tx,
        );
        await tx.pendingExpense.update({
          where: { conversationId },
          data: {
            status: 'CONFIRMED',
            expenseId: expense.id,
            confirmationRequested: false,
            duplicateReviewRequired: false,
          },
        });
        return expense;
      },
      signal,
    );
  }

  async cancel(conversationId: string, revision: number, signal?: AbortSignal) {
    return this.locked(
      conversationId,
      async (tx) => {
        const result = await tx.pendingExpense.updateMany({
          where: { conversationId, revision, status: 'PENDING' },
          data: { status: 'CANCELLED', confirmationRequested: false },
        });
        return result.count === 1;
      },
      signal,
    );
  }

  summary(pending: PendingExpense) {
    return {
      state:
        pending.status === 'CONFIRMED'
          ? 'SAVED'
          : pending.status === 'CANCELLED'
            ? 'CANCELLED'
            : this.missingFields(pending).length
              ? 'AWAITING_DETAILS'
              : pending.confirmationRequested
                ? 'AWAITING_CONFIRMATION'
                : 'AWAITING_REVIEW',
      payer: pending.payer ?? null,
      paymentMethod: pending.paymentMethod ?? null,
      category: pending.category,
      amount: pending.amount?.toFixed(2) ?? null,
      currency: pending.currency,
      merchant: pending.merchant,
      description: pending.description,
      transactionDate: pending.transactionDate?.toISOString() ?? null,
      status: pending.status,
      revision: pending.revision,
      duplicateReviewRequired: pending.duplicateReviewRequired,
      confirmationRequested: pending.confirmationRequested,
    };
  }

  missingFields(pending: PendingExpense) {
    return (['amount', 'currency', 'transactionDate', 'payer'] as const).filter(
      (field) => pending[field] == null,
    );
  }

  async applyIntent(
    conversationId: string,
    input: ExpenseIntentDto,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ): Promise<ExpenseWriteResult> {
    const intent = plainToInstance(ExpenseIntentDto, input);
    if (
      validateSync(intent, { whitelist: true, forbidNonWhitelisted: true })
        .length
    )
      throw new BadRequestException('Invalid expense intent');
    signal?.throwIfAborted();
    const current = await this.get(conversationId);
    if ((current?.revision ?? null) !== expectedRevision)
      throw new ConflictException('Pending expense changed; review again');
    const changes = Object.fromEntries(
      intent.changes.map((change) => [change.field, change.value]),
    ) as Partial<CreateExpenseDto>;
    if (
      [
        'CONFIRM',
        'DUPLICATE_CONFIRM',
        'CANCEL',
        'NO_ACTION',
        'STATUS',
      ].includes(intent.action) &&
      intent.changes.length
    )
      return {
        type: 'WRITE_REJECTED',
        reason: 'Review changes separately before confirming',
      };
    if (intent.action === 'CREATE' || intent.action === 'PATCH') {
      const draft =
        intent.action === 'CREATE'
          ? await this.prepareDraft(
              conversationId,
              changes,
              expectedRevision,
              signal,
            )
          : current?.status === 'PENDING' && intent.changes.length
            ? await this.patchDraft(
                conversationId,
                changes,
                current.revision,
                signal,
              )
            : null;
      if (!draft)
        return { type: 'WRITE_REJECTED', reason: 'No active draft to patch' };
      return this.reviewDraft(conversationId, draft, signal);
    }
    if (!current || intent.action === 'NO_ACTION')
      return { type: 'WRITE_REJECTED', reason: 'No explicit expense action' };
    if (intent.action === 'STATUS')
      return {
        type: 'EXPENSE_STATUS',
        pendingRevision: current.revision,
        draft: this.summary(current),
        ...(current.status === 'CONFIRMED' && current.expenseId
          ? { expenseId: current.expenseId }
          : {}),
      };
    if (intent.action === 'CANCEL') {
      const cancelled = await this.cancel(
        conversationId,
        current.revision,
        signal,
      );
      return {
        type:
          cancelled || current.status === 'CANCELLED'
            ? 'EXPENSE_CANCELLED'
            : 'WRITE_REJECTED',
        pendingRevision: current.revision,
      };
    }
    if (current.status === 'CANCELLED')
      return { type: 'WRITE_REJECTED', reason: 'Draft cancelled' };
    if (
      current.status === 'PENDING' &&
      (!current.confirmationRequested || this.missingFields(current).length)
    )
      return this.reviewDraft(conversationId, current, signal);
    if (
      intent.action === 'DUPLICATE_CONFIRM' &&
      current.status === 'PENDING' &&
      !current.duplicateReviewRequired
    )
      return { type: 'WRITE_REJECTED', reason: 'No duplicate review active' };
    const saved = await this.confirm(
      conversationId,
      current.revision,
      intent.action === 'DUPLICATE_CONFIRM',
      signal,
    );
    if (!saved)
      return {
        type: 'DUPLICATE_CONFIRMATION_REQUIRED',
        pendingRevision: current.revision,
        draft: { ...this.summary(current), duplicateReviewRequired: true },
      };
    return {
      type: 'EXPENSE_SAVED',
      pendingRevision: current.revision,
      expenseId: saved.id,
    };
  }

  private async reviewDraft(
    conversationId: string,
    draft: PendingExpense,
    signal?: AbortSignal,
  ): Promise<ExpenseWriteResult> {
    const missingFields = this.missingFields(draft);
    if (missingFields.length)
      return {
        type: 'MISSING_INFORMATION',
        pendingRevision: draft.revision,
        draft: this.summary(draft),
        missingFields,
      };
    await this.requestConfirmation(conversationId, draft.revision, signal);
    return {
      type: draft.duplicateReviewRequired
        ? 'DUPLICATE_CONFIRMATION_REQUIRED'
        : 'CONFIRMATION_REQUIRED',
      pendingRevision: draft.revision,
      draft: {
        ...this.summary(draft),
        confirmationRequested: true,
        state: 'AWAITING_CONFIRMATION',
      },
    };
  }

  private async locked<T>(
    conversationId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      return await this.prisma.$transaction(async (tx) => {
        // Parent row lock serializes preparation, correction, cancellation and confirmation.
        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        signal?.throwIfAborted();
        const result = await operation(tx);
        signal?.throwIfAborted();
        return result;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Unable to save pending expense; retry safely',
      );
    }
  }
}
