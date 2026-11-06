import { Module } from '@nestjs/common';
import { SendingRuleController } from './sending-rule.controller';
import { SendingRuleService } from './sending-rule.service';

@Module({
  controllers: [SendingRuleController],
  providers: [SendingRuleService],
})
export class SendingRuleModule {}
