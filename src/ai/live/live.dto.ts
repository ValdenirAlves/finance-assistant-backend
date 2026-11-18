import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
export class LiveOfferDto {
  @IsString() @MaxLength(90000) @Matches(/^v=0\r?\n/) sdp!: string;
  @IsOptional() @IsUUID() conversationId?: string;
}
