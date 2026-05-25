import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  BatchContactActionInput,
  CreateContactInput,
  CreateContactListInput,
  ListContactsQuery,
  UpdateContactListInput,
} from '@sendmast/shared';

@Injectable()
export class ContactService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Lists ----------

  async listLists(accountId: string) {
    const lists = await this.prisma.contactList.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { memberships: true } } },
    });
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      contactsCount: l._count.memberships,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }));
  }

  async getList(accountId: string, id: string) {
    const list = await this.prisma.contactList.findFirst({ where: { id, accountId } });
    if (!list) throw new NotFoundException('联系人列表不存在');
    const count = await this.prisma.contactListMembership.count({ where: { listId: id } });
    return { ...list, contactsCount: count };
  }

  async createList(accountId: string, input: CreateContactListInput) {
    return this.prisma.contactList.create({
      data: { accountId, name: input.name, description: input.description },
    });
  }

  async updateList(accountId: string, id: string, input: UpdateContactListInput) {
    const existing = await this.prisma.contactList.findFirst({ where: { id, accountId } });
    if (!existing) throw new NotFoundException('联系人列表不存在');
    return this.prisma.contactList.update({
      where: { id },
      data: { name: input.name, description: input.description },
    });
  }

  async deleteList(accountId: string, id: string) {
    const existing = await this.prisma.contactList.findFirst({ where: { id, accountId } });
    if (!existing) throw new NotFoundException('联系人列表不存在');
    await this.prisma.contactList.delete({ where: { id } });
  }

  // ---------- Contacts ----------

  async listContacts(accountId: string, query: ListContactsQuery) {
    const where: Prisma.ContactWhereInput = { accountId };

    if (query.status) where.subscriptionStatus = query.status;
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { email: { contains: s, mode: 'insensitive' } },
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
      ];
    }
    if (query.listId) {
      where.memberships = { some: { listId: query.listId } };
    }

    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async createContact(accountId: string, input: CreateContactInput) {
    const { listIds, birthday, ...rest } = input;
    const contact = await this.prisma.contact.upsert({
      where: { accountId_email: { accountId, email: input.email } },
      update: { ...rest, birthday: birthday ? new Date(birthday) : undefined },
      create: {
        accountId,
        ...rest,
        birthday: birthday ? new Date(birthday) : undefined,
      },
    });
    if (listIds?.length) {
      await this.prisma.contactListMembership.createMany({
        data: listIds.map((listId) => ({ listId, contactId: contact.id })),
        skipDuplicates: true,
      });
    }
    return contact;
  }

  async deleteContact(accountId: string, id: string) {
    const existing = await this.prisma.contact.findFirst({ where: { id, accountId } });
    if (!existing) throw new NotFoundException('联系人不存在');
    await this.prisma.contact.delete({ where: { id } });
  }

  async batchAction(accountId: string, input: BatchContactActionInput) {
    if (input.action === 'removeFromList') {
      const list = await this.prisma.contactList.findFirst({
        where: { id: input.listId!, accountId },
        select: { id: true },
      });
      if (!list) throw new NotFoundException('联系人列表不存在');
      const result = await this.prisma.contactListMembership.deleteMany({
        where: {
          listId: input.listId!,
          contact: { accountId },
          contactId: { in: input.ids },
        },
      });
      return { affected: result.count };
    }

    const status = input.action === 'subscribe' ? 'subscribed' : 'unsubscribed';
    const result = await this.prisma.contact.updateMany({
      where: { accountId, id: { in: input.ids } },
      data: { subscriptionStatus: status },
    });
    return { affected: result.count };
  }

  async addToList(accountId: string, listId: string, contactIds: string[]) {
    const list = await this.prisma.contactList.findFirst({ where: { id: listId, accountId } });
    if (!list) throw new NotFoundException('联系人列表不存在');
    await this.prisma.contactListMembership.createMany({
      data: contactIds.map((contactId) => ({ listId, contactId })),
      skipDuplicates: true,
    });
  }

  async accountStats(accountId: string) {
    const [total, subscribed] = await Promise.all([
      this.prisma.contact.count({ where: { accountId } }),
      this.prisma.contact.count({ where: { accountId, subscriptionStatus: 'subscribed' } }),
    ]);
    return { total, subscribed };
  }
}
