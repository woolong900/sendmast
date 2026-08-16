import { Injectable } from '@nestjs/common';
import type { EmailChannel } from '@prisma/client';
import type {
  SenderDomainDnsRecord,
  SenderDomainVerificationStatus,
  SenderDomainVerificationStates,
} from '@sendmast/shared';

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: Array<{ message?: string; code?: number | string }>;
  messages?: Array<{ message?: string }>;
  result?: T;
}

interface CloudflareZone {
  id?: string;
  name?: string;
}

interface CloudflareSubdomain {
  enabled?: boolean;
  name?: string;
  tag?: string;
  id?: string;
  dkim_selector?: string;
  return_path_domain?: string;
}

interface CloudflareDnsRecord {
  type?: string;
  name?: string;
  content?: string;
  value?: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  status?: string;
}

@Injectable()
export class CloudflareEmailService {
  async createDomain(acct: EmailChannel, domain: string) {
    const zone = await this.findZone(acct, domain);
    if (!zone.id) throw new Error(`Cloudflare channel ${acct.name}: 找不到 ${domain} 对应的 Zone`);

    const created = await this.createSubdomain(acct, zone.id, domain);
    const subdomainId = this.subdomainId(created);
    if (!subdomainId) {
      throw new Error(`Cloudflare channel ${acct.name}: 创建 ${domain} 后未返回 subdomain ID`);
    }

    const records = await this.getDnsRecords(acct, zone.id, subdomainId);
    return {
      providerDomainId: subdomainId,
      cloudflareZoneId: zone.id,
      records,
      states: this.toStates(created, records),
    };
  }

  async verifyDomain(
    acct: EmailChannel,
    zoneId: string,
    subdomainId: string,
  ): Promise<{ records: SenderDomainDnsRecord[]; states: SenderDomainVerificationStates }> {
    const [subdomain, records] = await Promise.all([
      this.request<CloudflareSubdomain>(
        acct,
        `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(
          subdomainId,
        )}`,
      ),
      this.getDnsRecords(acct, zoneId, subdomainId),
    ]);
    return { records, states: this.toStates(subdomain, records) };
  }

  async deleteDomain(acct: EmailChannel, zoneId: string, subdomainId: string): Promise<void> {
    await this.request(
      acct,
      `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(
        subdomainId,
      )}`,
      { method: 'DELETE' },
    );
  }

  private async findZone(acct: EmailChannel, domain: string): Promise<CloudflareZone> {
    const labels = domain.split('.').filter(Boolean);
    for (let i = 0; i < labels.length - 1; i += 1) {
      const candidate = labels.slice(i).join('.');
      const zones = await this.request<CloudflareZone[]>(
        acct,
        `/zones?name=${encodeURIComponent(candidate)}`,
      );
      const exact = zones.find((z) => z.name === candidate && z.id);
      if (exact) return exact;
    }
    throw new Error(`Cloudflare channel ${acct.name}: 未找到 ${domain} 对应的 Cloudflare Zone`);
  }

  private async createSubdomain(
    acct: EmailChannel,
    zoneId: string,
    domain: string,
  ): Promise<CloudflareSubdomain> {
    try {
      return await this.request<CloudflareSubdomain>(
        acct,
        `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`,
        {
          method: 'POST',
          body: JSON.stringify({ name: domain }),
        },
      );
    } catch (err) {
      const message = (err as Error).message.toLowerCase();
      if (!message.includes('already') && !message.includes('exist')) throw err;
      const existing = await this.findSubdomain(acct, zoneId, domain);
      if (existing) return existing;
      throw err;
    }
  }

  private async findSubdomain(
    acct: EmailChannel,
    zoneId: string,
    domain: string,
  ): Promise<CloudflareSubdomain | null> {
    const subdomains = await this.request<CloudflareSubdomain[]>(
      acct,
      `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`,
    );
    return subdomains.find((s) => s.name === domain || s.tag === domain || s.id === domain) ?? null;
  }

  private async getDnsRecords(
    acct: EmailChannel,
    zoneId: string,
    subdomainId: string,
  ): Promise<SenderDomainDnsRecord[]> {
    const result = await this.request<unknown>(
      acct,
      `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(
        subdomainId,
      )}/dns`,
    );
    return this.toRecords(extractDnsRecords(result));
  }

  private toRecords(records: CloudflareDnsRecord[]): SenderDomainDnsRecord[] {
    const out: SenderDomainDnsRecord[] = [];
    let dkimCount = 0;
    for (const record of records) {
      const type = (record.type ?? '').toUpperCase();
      const name = record.name;
      const value = record.content ?? record.value;
      if ((type !== 'TXT' && type !== 'CNAME' && type !== 'MX') || !name || !value) continue;

      const kind = recordKind(record, dkimCount);
      if (!kind) continue;
      if (kind === 'DKIM' || kind === 'DKIM2') dkimCount += 1;

      out.push({
        kind,
        type,
        name,
        value,
        ttl: typeof record.ttl === 'number' ? record.ttl : undefined,
        priority: typeof record.priority === 'number' ? record.priority : undefined,
      });
    }
    return out;
  }

  private toStates(
    subdomain: CloudflareSubdomain,
    records: SenderDomainDnsRecord[],
  ): SenderDomainVerificationStates {
    const status: SenderDomainVerificationStatus = subdomain.enabled
      ? 'Verified'
      : 'VerificationRequested';
    const states: SenderDomainVerificationStates = {};
    for (const record of records) {
      states[record.kind] = { status };
    }
    return states;
  }

  private subdomainId(subdomain: CloudflareSubdomain): string | null {
    return subdomain.tag ?? subdomain.id ?? subdomain.name ?? null;
  }

  private async request<T = unknown>(
    acct: EmailChannel,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!acct.cloudflareApiToken) {
      throw new Error(`Cloudflare channel ${acct.name}: API Token 未配置`);
    }
    const base = (acct.cloudflareApiBaseUrl || 'https://api.cloudflare.com/client/v4').replace(
      /\/+$/,
      '',
    );
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${acct.cloudflareApiToken}`);
    headers.set('User-Agent', 'sendmast/1.0');
    if (init.body) headers.set('Content-Type', 'application/json');

    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const json = parseJson(text) as CloudflareEnvelope<T>;
    if (!res.ok || json.success === false) {
      throw new Error(`Cloudflare API ${res.status}: ${cloudflareMessage(json, text)}`);
    }
    return json.result as T;
  }
}

function extractDnsRecords(input: unknown): CloudflareDnsRecord[] {
  if (Array.isArray(input)) return input as CloudflareDnsRecord[];
  if (!input || typeof input !== 'object') return [];
  const object = input as Record<string, unknown>;
  for (const key of ['records', 'dns_records', 'dnsRecords']) {
    const value = object[key];
    if (Array.isArray(value)) return value as CloudflareDnsRecord[];
  }
  return [];
}

function recordKind(
  record: CloudflareDnsRecord,
  dkimCount: number,
): SenderDomainDnsRecord['kind'] | null {
  const haystack = `${record.type ?? ''} ${record.name ?? ''} ${record.content ?? ''} ${
    record.value ?? ''
  }`.toLowerCase();
  if (haystack.includes('_dmarc')) return 'DMARC';
  if (haystack.includes('_domainkey') || haystack.includes('dkim')) {
    return dkimCount === 0 ? 'DKIM' : 'DKIM2';
  }
  if (haystack.includes('spf1')) return 'SPF';
  if ((record.type ?? '').toUpperCase() === 'MX') return 'Domain';
  if (haystack.includes('return') || haystack.includes('bounce')) return 'Domain';
  return 'Domain';
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text.slice(0, 4096) };
  }
}

function cloudflareMessage(payload: CloudflareEnvelope<unknown>, fallback: string): string {
  const errors = payload.errors
    ?.map((e) => [e.code, e.message].filter(Boolean).join(' '))
    .filter(Boolean);
  if (errors?.length) return errors.join('; ');
  const messages = payload.messages?.map((m) => m.message).filter(Boolean);
  if (messages?.length) return messages.join('; ');
  return fallback;
}
