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

export const EXPENSE_DRAFT_FIELDS = [
  'amount',
  'currency',
  'transactionDate',
  'merchant',
  'description',
  'category',
  'payer',
  'paymentMethod',
] as const;
export class ExpenseDraftChange {
  @IsIn(EXPENSE_DRAFT_FIELDS) field!: (typeof EXPENSE_DRAFT_FIELDS)[number];
  @ValidateIf((_object, value) => value !== null)
  @IsDefined()
  @IsString()
  value!: string | null;
}
export class ExpenseIntentDto {
  @IsIn([
    'CREATE',
    'PATCH',
    'CONFIRM',
    'CANCEL',
    'DUPLICATE_CONFIRM',
    'NO_ACTION',
    'STATUS',
  ])
  action!:
    | 'CREATE'
    | 'PATCH'
    | 'CONFIRM'
    | 'CANCEL'
    | 'DUPLICATE_CONFIRM'
    | 'NO_ACTION'
    | 'STATUS';
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique((change: ExpenseDraftChange | null) => change?.field)
  @ValidateNested({ each: true })
  @Type(() => ExpenseDraftChange)
  changes!: ExpenseDraftChange[];
}
