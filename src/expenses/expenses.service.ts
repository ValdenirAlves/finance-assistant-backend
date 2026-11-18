import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { Expense } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { FilterExpensesDto } from './dto/filter-expenses.dto.js';
import { parseDateRange } from '../common/date-range.js';
import { merchantFilter } from '../common/merchant-filter.js';
import { CategoriesService } from '../categories/categories.service.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';

@Injectable()
export class ExpensesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(CategoriesService)
    private readonly categories?: CategoriesService,
  ) {}
  async categoryFor(merchant?: string | null) {
    return this.categories?.lookup(merchant) ?? null;
  }
  async learnCategory(
    merchant: string | null | undefined,
    category: ExpenseCategory,
    tx: Prisma.TransactionClient,
  ) {
    await this.categories?.learn(merchant, category, tx);
  }

  validateCreate(input: CreateExpenseDto) {
    const dto = plainToInstance(CreateExpenseDto, input);
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }
    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.gt('0')) {
      throw new BadRequestException('amount must be greater than 0');
    }
    const transactionDate = new Date(dto.transactionDate);
    if (Number.isNaN(transactionDate.getTime())) {
      throw new BadRequestException('transactionDate must be a valid date');
    }
    return {
      payer: dto.payer ?? null,
      paymentMethod: dto.paymentMethod ?? null,
      category: dto.category ?? ExpenseCategory.OTHER,
      amount,
      currency: dto.currency,
      transactionDate,
      description: dto.description ?? null,
      merchant: dto.merchant ?? null,
    };
  }

  async create(
    input: CreateExpenseDto,
    transaction?: Prisma.TransactionClient,
  ) {
    const data = this.validateCreate(input);
    if (!transaction)
      data.category = (await this.categoryFor(input.merchant)) ?? data.category;
    if (!data.payer)
      throw new BadRequestException(
        'Specify payer SELF or SPOUSE before saving',
      );
    const debit =
      data.payer === 'SELF' &&
      (data.paymentMethod === 'CARD' || data.paymentMethod === 'BANK_ACCOUNT');
    const save = async (tx: Prisma.TransactionClient) => {
      if (debit) {
        const changed = await tx.bankAccount.updateMany({
          where: { owner: 'SELF', currency: data.currency },
          data: { currentBalance: { decrement: data.amount } },
        });
        if (changed.count !== 1)
          throw new BadRequestException(
            `Set your ${data.currency} bank balance before saving a SELF expense`,
          );
      }
      return tx.expense.create({ data });
    };
    const expense = transaction
      ? await save(transaction)
      : debit
        ? await this.prisma.$transaction(save)
        : await this.prisma.expense.create({ data });
    return this.serialize(expense);
  }

  async findPotentialDuplicate(
    input: CreateExpenseDto,
    transaction?: Prisma.TransactionClient,
  ) {
    const data = this.validateCreate(input);
    const start = new Date(data.transactionDate);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    // Escape LIKE metacharacters even for case-insensitive equality.
    const merchant =
      data.merchant === null
        ? null
        : {
            equals: data.merchant.replace(/[\\%_]/g, '\\$&'),
            mode: 'insensitive' as const,
          };
    return (transaction ?? this.prisma).expense.findFirst({
      where: {
        amount: data.amount,
        currency: data.currency,
        merchant,
        transactionDate: { gte: start, lt: end },
      },
      orderBy: { id: 'asc' },
    });
  }

  async findAll(input: FilterExpensesDto = {}) {
    const filters = plainToInstance(FilterExpensesDto, input);
    const errors = validateSync(filters, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }
    const { from, to } = parseDateRange(
      filters.from ?? undefined,
      filters.to ?? undefined,
    );
    const where: Prisma.ExpenseWhereInput = {};
    if (filters.category) where.category = filters.category;
    if (filters.currency) where.currency = filters.currency;
    if (filters.merchant !== undefined && filters.merchant !== null) {
      // Escape PostgreSQL LIKE wildcards so the search treats input as literal text.
      where.merchant = merchantFilter(filters.merchant);
    }
    if (from || to) {
      where.transactionDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }
    const expenses = await this.prisma.expense.findMany({
      ...(Object.keys(where).length ? { where } : {}),
      orderBy: { transactionDate: 'desc' },
    });
    return expenses.map((expense) => this.serialize(expense));
  }

  async findById(id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    return this.serialize(expense);
  }

  private serialize(expense: Expense) {
    return { ...expense, amount: expense.amount.toFixed(2) };
  }
}
