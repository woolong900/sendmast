import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { renderMjml } from './mjml-renderer';
import type { CreateTemplateInput, ListTemplatesQuery, UpdateTemplateInput } from '@sendmast/shared';

@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string, query: ListTemplatesQuery) {
    const where: any = {};
    if (query.scope === 'system') where.scope = 'system';
    else if (query.scope === 'user') where.scope = 'user';
    else where.OR = [{ scope: 'system' }, { accountId }];
    if (query.category) where.category = query.category;
    return this.prisma.emailTemplate.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async get(accountId: string, id: string) {
    const t = await this.prisma.emailTemplate.findFirst({
      where: { id, OR: [{ scope: 'system' }, { accountId }] },
    });
    if (!t) throw new NotFoundException('模板不存在');
    return t;
  }

  async create(accountId: string, input: CreateTemplateInput) {
    const { mjml, html } = this.resolveBody(input);
    return this.prisma.emailTemplate.create({
      data: {
        accountId,
        scope: 'user',
        name: input.name,
        category: input.category,
        thumbnail: input.thumbnail,
        mjml,
        html,
        designJson: (input.designJson as any) ?? undefined,
      },
    });
  }

  async update(accountId: string, id: string, input: UpdateTemplateInput) {
    const t = await this.prisma.emailTemplate.findFirst({ where: { id, accountId } });
    if (!t) throw new NotFoundException('模板不存在');
    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category;
    if (input.thumbnail !== undefined) data.thumbnail = input.thumbnail;
    // Easy Email path sends both `html` (already rendered client-side via
    // mjml-browser) AND `mjml` (so admins can audit / re-render later).
    // Pure-HTML path (admin paste / future drag-drop without MJML) sends only
    // `html` — in that case clear the `mjml` column so we don't keep stale
    // MJML that no longer matches the html.
    // Pure-MJML path (legacy / API-only callers) sends only `mjml` — server
    // renders to html.
    if (input.html !== undefined) {
      data.html = input.html;
      data.mjml = input.mjml ?? null;
    } else if (input.mjml !== undefined) {
      const rendered = renderMjml(input.mjml);
      if (rendered.errors.length > 0 && !rendered.html) {
        throw new BadRequestException(`MJML 渲染错误：${rendered.errors.join('; ')}`);
      }
      data.mjml = input.mjml;
      data.html = rendered.html;
    }
    if (input.designJson !== undefined) data.designJson = input.designJson as any;
    return this.prisma.emailTemplate.update({ where: { id }, data });
  }

  /**
   * - Easy Email sends both html + mjml: keep both verbatim.
   * - Drag-drop / paste sends only html: store html, mjml = null.
   * - API-only / legacy MJML path sends only mjml: server renders html.
   */
  private resolveBody(input: { mjml?: string; html?: string }): {
    mjml: string | null;
    html: string;
  } {
    if (input.html) {
      return { mjml: input.mjml ?? null, html: input.html };
    }
    if (!input.mjml) {
      throw new BadRequestException('请提供 mjml 或 html 内容');
    }
    const rendered = renderMjml(input.mjml);
    if (rendered.errors.length > 0 && !rendered.html) {
      throw new BadRequestException(`MJML 渲染错误：${rendered.errors.join('; ')}`);
    }
    return { mjml: input.mjml, html: rendered.html };
  }

  async remove(accountId: string, id: string) {
    const t = await this.prisma.emailTemplate.findFirst({ where: { id, accountId } });
    if (!t) throw new NotFoundException('模板不存在');
    await this.prisma.emailTemplate.delete({ where: { id } });
  }

  async preview(mjml: string) {
    return renderMjml(mjml);
  }
}
