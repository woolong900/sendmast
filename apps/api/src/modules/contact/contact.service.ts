import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  BatchContactActionInput,
  CreateContactInput,
  CreateContactListInput,
  ListContactsQuery,
  UpdateContactListInput,
} from '@sendmast/shared';

/** Columns emitted by `exportListToCsv`. Order is intentionally identical
 *  to the import template in apps/web/src/pages/contacts/ImportContactsDialog.tsx
 *  so that export → re-import round-trips cleanly without manual remapping.
 *  Header row uses snake_case to match the import-side schema mapper. */
const EXPORT_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'phone',
  'gender',
  'country',
  'state',
  'city',
  'zip',
  'language',
] as const;

/** Cursor page size for export. 1000 keeps each Prisma round-trip cheap
 *  (~one TCP MSS worth of rows) without flooding PG's row-cache; smaller
 *  values multiply round-trip overhead, larger ones spike memory per page
 *  when contacts have long demographic strings. */
const EXPORT_PAGE_SIZE = 1000;

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

  // ---------- Export ----------

  /**
   * Stream a list's contacts as CSV directly into the HTTP response. Uses
   * id-based cursor pagination so memory is bounded by EXPORT_PAGE_SIZE
   * rows at a time — safe for lists with millions of contacts.
   *
   * Format mirrors the import template (UTF-8 BOM + snake_case headers +
   * \r\n line endings) so an exported file can be re-imported without any
   * manual reshaping. Cells are RFC 4180-quoted when they contain
   * comma / quote / newline.
   *
   * Always exports the FULL list — search / status filters from the UI
   * are intentionally ignored here so the "export" affordance has
   * predictable semantics ("download every contact in this list").
   */
  async exportListToCsv(accountId: string, listId: string, res: Response): Promise<void> {
    const list = await this.prisma.contactList.findFirst({
      where: { id: listId, accountId },
      select: { id: true, name: true },
    });
    if (!list) throw new NotFoundException('联系人列表不存在');

    const filename = buildExportFilename(list.name);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      // RFC 5987 — `filename*` carries UTF-8 so Chinese list names survive
      // Chrome/Firefox; plain `filename=` is the ASCII fallback for
      // legacy clients that can't decode it.
      `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    // UTF-8 BOM so Excel on Windows opens it without garbling Chinese
    // (matches the import template emitted by the web client).
    res.write('\ufeff');
    res.write(EXPORT_COLUMNS.join(',') + '\r\n');

    let cursor: string | undefined;
    // Iterate by ascending id (stable, indexed by PK). We could also order
    // by createdAt, but id avoids tie-breaks and Prisma's `cursor` skip
    // semantics are simplest on the PK.
    for (;;) {
      const rows = await this.prisma.contact.findMany({
        where: { memberships: { some: { listId } } },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          gender: true,
          country: true,
          state: true,
          city: true,
          zip: true,
          language: true,
        },
        orderBy: { id: 'asc' },
        take: EXPORT_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;

      let chunk = '';
      for (const r of rows) {
        chunk +=
          [
            r.email,
            r.firstName ?? '',
            r.lastName ?? '',
            r.phone ?? '',
            r.gender ?? '',
            r.country ?? '',
            r.state ?? '',
            r.city ?? '',
            r.zip ?? '',
            r.language ?? '',
          ]
            .map(csvField)
            .join(',') + '\r\n';
      }
      // Respect TCP back-pressure: if the OS write buffer is full, wait
      // for `drain` before issuing the next Prisma query. Without this a
      // slow client + large list could pin every contact row in Node's
      // outgoing buffer (= heap OOM).
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', () => resolve()));
      }

      if (rows.length < EXPORT_PAGE_SIZE) break;
      cursor = rows[rows.length - 1].id;
    }

    res.end();
  }
}

// ---------- CSV helpers ----------

function csvField(v: string | null | undefined): string {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Slug a list name into a safe filename component. Keeps Chinese
 *  characters (browsers decode `filename*=UTF-8''…` fine); strips path
 *  separators and ASCII control chars; trims to 80 to leave room for the
 *  date suffix in common filesystem name limits (255). */
function buildExportFilename(listName: string): string {
  const safe =
    listName
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .trim()
      .slice(0, 80) || 'contacts';
  const date = new Date().toISOString().slice(0, 10);
  return `${safe}-${date}.csv`;
}

/** ASCII-only fallback for `filename=` (legacy clients). Anything outside
 *  printable ASCII becomes `_`. The real filename is delivered via
 *  `filename*=UTF-8''…` per RFC 5987 alongside this. */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7E]+/g, '_');
}
