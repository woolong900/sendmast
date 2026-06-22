import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { CampaignService } from './campaign.service';

jest.mock('@sendmast/shared', () => ({ QUEUE_NAMES: {} }));

describe('CampaignService recipient export', () => {
  it('creates one formatted worksheet per visible detail tab', async () => {
    const prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue({
          name: '六月活动',
          account: { isCollaborator: false },
        }),
      },
    };
    const service = new CampaignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(service, 'listRecipients')
      .mockImplementation(async (_account, _campaign, query) => ({
        source: 'events',
        rows: [
          {
            id: `row-${query.dimension}`,
            email: 'hello@example.com',
            firstName: 'Ming',
            lastName: 'Li',
            status: 'sent',
            messageId: null,
            errorMessage: '示例原因',
            sentAt: '2026-06-22T08:30:00.000Z',
            createdAt: '2026-06-22T08:30:00.000Z',
            eventTime: '2026-06-22T08:31:00.000Z',
            userAgent: 'Mozilla/5.0',
            linkUrl: 'https://example.com/path',
            deliveredAt: '2026-06-22T08:30:30.000Z',
            reason: '示例原因',
            bounceType: '硬退',
            orderNo: 'ORDER-1',
            orderAmount: 123.45,
            orderCurrency: 'AUD',
          },
        ],
        nextCursor: null,
        total: 1,
      }));

    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const headers = new Map<string, string>();
    const response = Object.assign(stream, {
      setHeader: (name: string, value: string) => headers.set(name, value),
    }) as unknown as Response;

    await service.exportRecipientsToXlsx('account-id', 'campaign-id', response);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '发送',
      '送达',
      '投递中',
      '打开',
      '点击',
      '销售额',
      '发送失败',
      '无效邮箱',
      '退订',
    ]);
    expect(workbook.getWorksheet('弹回')).toBeUndefined();
    expect(workbook.getWorksheet('销售额')?.getCell('D2').value).toBe(123.45);
    expect(workbook.getWorksheet('发送')?.getCell('C2').value).toBeInstanceOf(Date);
    expect(headers.get('Content-Type')).toContain('spreadsheetml.sheet');
  });
});
