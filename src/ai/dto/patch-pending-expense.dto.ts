import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const PENDING_EXPENSE_FIELDS = [
  'amount',
  'currency',
  'merchant',
  'description',
  'transactionDate',
  'category',
  'payer',
  'paymentMethod',
] as const;
export class PendingExpenseChangeDto {
  @IsIn(PENDING_EXPENSE_FIELDS)
  field!: (typeof PENDING_EXPENSE_FIELDS)[number];

  @ValidateIf((_object, value) => value !== null)
  @IsDefined()
  @IsString()
  value!: string | null;
}
export class PatchPendingExpenseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PENDING_EXPENSE_FIELDS.length)
  @ArrayUnique((change: PendingExpenseChangeDto | null) => change?.field)
  @ValidateNested({ each: true })
  @Type(() => PendingExpenseChangeDto)
  changes!: PendingExpenseChangeDto[];

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  language?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  @Matches(/^[^\d€$]+$/)
  confirmationQuestion?: string | null;
}
