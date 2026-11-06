import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateSendingRuleSchema } from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { SendingRuleService } from './sending-rule.service';

@ApiTags('sending-rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sending-rules')
export class SendingRuleController {
  constructor(private readonly service: SendingRuleService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.accountId);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = CreateSendingRuleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(firstZodError(parsed.error));
    return this.service.create(user.accountId, parsed.data);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.remove(user.accountId, id);
  }
}
