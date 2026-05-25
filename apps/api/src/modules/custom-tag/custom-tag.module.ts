import { Module } from '@nestjs/common';
import { CustomTagController } from './custom-tag.controller';
import { CustomTagService } from './custom-tag.service';

@Module({
  controllers: [CustomTagController],
  providers: [CustomTagService],
  exports: [CustomTagService],
})
export class CustomTagModule {}
