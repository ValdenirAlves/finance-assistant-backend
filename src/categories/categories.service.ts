import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
export const categoryLabels: Record<ExpenseCategory, [string, string]> = {
  GROCERIES: ['supermercado', 'groceries'],
  RESTAURANTS: ['restaurantes', 'restaurants'],
  TRANSPORT: ['transporte', 'transport'],
  FUEL: ['combustível', 'fuel'],
  UTILITIES: ['contas da casa', 'utilities'],
  RENT: ['aluguel', 'rent'],
  SUBSCRIPTIONS: ['assinaturas', 'subscriptions'],
  HEALTH: ['saúde', 'health'],
  PETS: ['pets', 'pets'],
  SHOPPING: ['compras', 'shopping'],
  ENTERTAINMENT: ['entretenimento', 'entertainment'],
  OTHER: ['outros', 'other'],
};
export function categoryLabel(category: ExpenseCategory, portuguese: boolean) {
  return (
    categoryLabels[category]?.[portuguese ? 0 : 1] ??
    categoryLabels.OTHER[portuguese ? 0 : 1]
  );
}
export function normalizeMerchant(merchant: string) {
  return merchant.trim().toLowerCase();
}
@Injectable()
export class CategoriesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async lookup(merchant?: string | null) {
    const key = merchant ? normalizeMerchant(merchant) : '';
    if (!key) return null;
    return (
      (
        await this.prisma.merchantCategoryMapping.findUnique({
          where: { normalizedMerchant: key },
        })
      )?.category ?? null
    );
  }
  async learn(
    merchant: string | null | undefined,
    category: ExpenseCategory,
    tx: Prisma.TransactionClient,
  ) {
    const key = merchant ? normalizeMerchant(merchant) : '';
    if (!key) return;
    // Insert-if-absent protects existing mappings, including concurrent confirmations.
    await tx.merchantCategoryMapping.createMany({
      data: [{ normalizedMerchant: key, category }],
      skipDuplicates: true,
    });
  }
}
