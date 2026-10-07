import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class ChatDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  conversationId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;
}
