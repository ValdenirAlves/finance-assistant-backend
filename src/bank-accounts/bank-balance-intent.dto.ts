import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Currency } from '../generated/prisma/enums.js';

export const BANK_BALANCE_FIELDS = [
  'currentBalance',
  'currency',
  'name',
] as const;
class BankBalanceChange {
  @IsIn(BANK_BALANCE_FIELDS) field!: (typeof BANK_BALANCE_FIELDS)[number];
  @ValidateIf((_object, value) => value !== null)
  @IsDefined()
  @IsString()
  value!: string | null;
}
export class BankBalanceIntentDto {
  @IsIn(['CREATE', 'PATCH', 'CONFIRM', 'CANCEL', 'NO_ACTION'])
  action!: 'CREATE' | 'PATCH' | 'CONFIRM' | 'CANCEL' | 'NO_ACTION';
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique((change: BankBalanceChange | null) => change?.field)
  @ValidateNested({ each: true })
  @Type(() => BankBalanceChange)
  changes!: BankBalanceChange[];
}
export type BankBalanceWriteResult =
  | {
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED';
      pendingRevision: number;
      balanceDraftDisclosureAllowed: true;
      draft: {
        currentBalance: string;
        currency: Currency;
        name: string | null;
      };
    }
  | {
      type: 'BANK_BALANCE_SAVED' | 'BANK_BALANCE_CANCELLED';
      pendingRevision: number;
    }
  | {
      type: 'MISSING_INFORMATION';
      domain: 'BANK_BALANCE';
      missingFields: string[];
    }
  | { type: 'WRITE_REJECTED'; reason: string };
