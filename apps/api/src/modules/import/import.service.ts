import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { S3Service } from '../../common/s3/s3.service';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_NAMES } from '@sendmast/shared';

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly queue: QueueService,
  ) {}

  async createFromUpload(
    accountId: string,
    listId: string | undefined,
    file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
    overwriteExisting = false,
  ) {
    if (!file) throw new BadRequestException('请上传文件');
    if (file.size > 200 * 1024 * 1024) throw new BadRequestException('文件过大（不能超过 200MB）');

    if (listId) {
      const list = await this.prisma.contactList.findFirst({ where: { id: listId, accountId } });
      if (!list) throw new NotFoundException('联系人列表不存在');
    }

    await this.s3.ensureBucket();
    const storageKey = `imports/${accountId}/${randomUUID()}-${file.originalname}`;
    await this.s3.putObject(storageKey, file.buffer, file.mimetype || 'text/csv');

    // totalRows is filled by the worker once it has streamed the file —
    // counting line breaks here would block the event loop on large CSVs.
    const job = await this.prisma.importJob.create({
      data: {
        accountId,
        listId: listId ?? null,
        filename: file.originalname,
        storageKey,
        status: 'pending',
      },
    });

    await this.queue.add(QUEUE_NAMES.IMPORT_CONTACTS, 'import', {
      jobId: job.id,
      overwriteExisting,
    });

    return job;
  }

  async get(accountId: string, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, accountId } });
    if (!job) throw new NotFoundException('导入任务不存在');
    return job;
  }

  async list(accountId: string) {
    return this.prisma.importJob.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
