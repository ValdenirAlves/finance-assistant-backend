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
import type { Budget, PendingBudget } from '../generated/prisma/client.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { BudgetScopeDto, CreateBudgetDto } from './dto/create-budget.dto.js';
const Decimal = Prisma.Decimal.clone({ precision: 40 });
import { budgetPaceGuidance } from './budget-pace.js';
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}
  scope(input: BudgetScopeDto) {
    const dto = plainToInstance(BudgetScopeDto, input);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length
    )
      throw new BadRequestException('Invalid budget scope');
    if ((dto.merchant != null) === (dto.category != null))
      throw new BadRequestException(
        'Provide exactly one of merchant or category',
      );
    const target = (dto.merchant ?? dto.category)!.trim();
    if (!target) throw new BadRequestException('Budget target cannot be empty');
    return {
      year: dto.year,
      month: dto.month,
      currency: dto.currency,
      merchant: dto.merchant != null ? target : null,
      category: dto.category ?? null,
      scopeKey: `${dto.merchant != null ? 'merchant' : 'category'}:${target.toLowerCase()}`,
    };
  }
  validateCreate(input: CreateBudgetDto) {
    const dto = plainToInstance(CreateBudgetDto, input);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length
    )
      throw new BadRequestException('Invalid budget');
    const { amount, ...scope } = dto;
    const data = this.scope(scope);
    const decimal = new Decimal(amount);
    if (!decimal.gt('0'))
      throw new BadRequestException('amount must be greater than 0');
    return { ...data, amount: decimal };
  }
  serialize(row: Budget) {
    const { scopeKey, ...result } = row;
    void scopeKey;
    return { ...result, amount: row.amount.toFixed(2) };
  }
  async create(
    input: CreateBudgetDto,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const data = this.validateCreate(input);
    try {
      return this.serialize(await tx.budget.create({ data }));
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'Budget already exists for this month, currency and scope',
        );
      throw error;
    }
  }
  async findAll() {
    return (
      await this.prisma.budget.findMany({
        orderBy: [{ year: 'desc' }, { month: 'desc' }, { id: 'asc' }],
      })
    ).map((row) => this.serialize(row));
  }
  async findById(id: string) {
    const row = await this.prisma.budget.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Budget not found');
    return this.serialize(row);
  }
  async status(id: string, effectiveDate?: Date) {
    const budget = await this.findById(id);
    const paceInput = {
      year: String(budget.year).padStart(4, '0'),
      month: String(budget.month),
      currency: budget.currency,
      merchant: budget.merchant ?? undefined,
      category: budget.category ?? undefined,
    };
    const pace = effectiveDate
      ? await this.analytics.spendingPace(paceInput, effectiveDate)
      : await this.analytics.spendingPace(paceInput);
    const result = pace.results[0];
    const spent = new Decimal(result.spentToDate),
      amount = new Decimal(budget.amount);
    const percentage = spent.div(amount).mul('100');
    return {
      budgetId: id,
      budgetAmount: budget.amount,
      spent: spent.toFixed(2),
      remaining: amount.minus(spent).toFixed(2),
      overage: spent.gt(amount) ? spent.minus(amount).toFixed(2) : '0.00',
      projectedOverage:
        result.projectedMonthTotal === null
          ? null
          : Decimal.max(
              new Decimal(result.projectedMonthTotal).minus(amount),
              '0',
            ).toFixed(2),
      percentageUsed: percentage.toFixed(2),
      ...budgetPaceGuidance(budget.amount, result.spentToDate, pace.period),
      currency: budget.currency,
      period: pace.period,
      merchant: budget.merchant,
      category: budget.category,
      status: percentage.gt('100')
        ? 'OVER_BUDGET'
        : percentage.gte('80')
          ? 'NEAR_LIMIT'
          : 'ON_TRACK',
      projectedMonthTotal: result.projectedMonthTotal,
      projectedOverBudget:
        result.projectedMonthTotal === null
          ? null
          : new Decimal(result.projectedMonthTotal).gt(amount),
    };
  }
  async statusFor(input: BudgetScopeDto) {
    const scope = this.scope(input);
    const row = await this.prisma.budget.findUnique({
      where: {
        year_month_currency_scopeKey: {
          year: scope.year,
          month: scope.month,
          currency: scope.currency,
          scopeKey: scope.scopeKey,
        },
      },
    });
    if (!row) throw new NotFoundException('Budget not found');
    return this.status(row.id);
  }
  async getPending(conversationId: string) {
    return this.prisma.pendingBudget.findUnique({ where: { conversationId } });
  }
  summary(row: PendingBudget) {
    return {
      amount: row.amount.toFixed(2),
      currency: row.currency,
      year: row.year,
      month: row.month,
      merchant: row.merchant,
      category: row.category,
      revision: row.revision,
    };
  }
  async prepare(conversationId: string, input: CreateBudgetDto) {
    const { scopeKey, ...data } = this.validateCreate(input);
    void scopeKey;
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      await tx.pendingExpense.updateMany({
        where: { conversationId, status: 'PENDING' },
        data: { status: 'CANCELLED', confirmationRequested: false },
      });
      await tx.pendingBankBalance.updateMany({
        where: { conversationId, status: 'PENDING' },
        data: { status: 'CANCELLED', confirmationRequested: false },
      });
      return tx.pendingBudget.upsert({
        where: { conversationId },
        create: { conversationId, ...data },
        update: {
          ...data,
          status: 'PENDING',
          revision: { increment: 1 },
          confirmationRequested: false,
          budgetId: null,
        },
      });
    });
  }
  private async transition(
    conversationId: string,
    data: Prisma.PendingBudgetUpdateManyMutationInput,
    revision?: number,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      return tx.pendingBudget.updateMany({
        where: {
          conversationId,
          status: 'PENDING',
          ...(revision === undefined ? {} : { revision }),
        },
        data,
      });
    });
  }
  async arm(conversationId: string, revision: number) {
    const result = await this.transition(
      conversationId,
      { confirmationRequested: true },
      revision,
    );
    if (result.count !== 1) throw new ConflictException('Budget draft changed');
  }
  async suspend(conversationId: string) {
    await this.transition(conversationId, { confirmationRequested: false });
  }
  async cancel(conversationId: string) {
    await this.transition(conversationId, {
      status: 'CANCELLED',
      confirmationRequested: false,
    });
  }
  async confirm(conversationId: string, revision: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      const row = await tx.pendingBudget.findUnique({
        where: { conversationId },
      });
      if (!row || row.revision !== revision)
        throw new ConflictException('Budget draft changed');
      if (row.status === 'CONFIRMED' && row.budgetId)
        return this.serialize(
          await tx.budget.findUniqueOrThrow({ where: { id: row.budgetId } }),
        );
      if (row.status !== 'PENDING' || !row.confirmationRequested)
        throw new BadRequestException('Review and confirm the budget first');
      const { revision: ignoredRevision, ...input } = this.summary(row);
      void ignoredRevision;
      const budget = await this.create(input as CreateBudgetDto, tx);
      await tx.pendingBudget.update({
        where: { conversationId },
        data: {
          status: 'CONFIRMED',
          budgetId: budget.id,
          confirmationRequested: false,
        },
      });
      return budget;
    });
  }
}
