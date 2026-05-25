import { Module } from '@nestjs/common';
import { ContactListController } from './contact-list.controller';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

@Module({
  controllers: [ContactListController, ContactController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
