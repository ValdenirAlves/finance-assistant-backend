import { Prisma } from '../generated/prisma/client.js';

// Presentation only: retain Decimal precision in persistence and calculations.
export function displayAmount(amount: string): string {
  return new Prisma.Decimal(amount).toFixed(2);
}
