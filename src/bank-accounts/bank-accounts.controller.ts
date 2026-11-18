import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { BankAccountsService } from './bank-accounts.service.js';
import {
  BalanceConfirmationDto,
  BalanceQueryDto,
  PrepareBalanceDto,
} from './bank-balance.dto.js';
const options = {
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
};
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(
    @Inject(BankAccountsService) private readonly accounts: BankAccountsService,
  ) {}
  @Get() findAll(
    @Query(new ValidationPipe({ ...options, expectedType: BalanceQueryDto }))
    query: BalanceQueryDto,
  ) {
    return this.accounts.findAll(query);
  }
  @Get(':id') findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findById(id);
  }
  @Post('balance-updates') async prepare(
    @Body(new ValidationPipe({ ...options, expectedType: PrepareBalanceDto }))
    dto: PrepareBalanceDto,
  ) {
    const { conversationId: requestedConversationId, ...input } = dto;
    const conversationId =
      requestedConversationId ?? (await this.accounts.createConversation()).id;
    const previous = await this.accounts.getPending(conversationId);
    const draft = await this.accounts.prepare(
      conversationId,
      input,
      previous?.revision ?? null,
    );
    await this.accounts.arm(conversationId, draft.revision);
    return {
      conversationId,
      revision: draft.revision,
      status: draft.status,
      currentBalance: draft.currentBalance.toFixed(2),
      currency: draft.currency,
      name: draft.name,
    };
  }
  @Post('balance-updates/confirm') async confirm(
    @Body(
      new ValidationPipe({ ...options, expectedType: BalanceConfirmationDto }),
    )
    dto: BalanceConfirmationDto,
  ) {
    return this.accounts.confirm(dto.conversationId, dto.revision);
  }
  @Post('balance-updates/cancel') async cancel(
    @Body(
      new ValidationPipe({ ...options, expectedType: BalanceConfirmationDto }),
    )
    dto: BalanceConfirmationDto,
  ) {
    await this.accounts.cancel(dto.conversationId, dto.revision);
    return { status: 'CANCELLED' };
  }
}
