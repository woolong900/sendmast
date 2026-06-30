import { Injectable } from '@nestjs/common';
import type { EmailChannel } from '@prisma/client';
import type {
  SenderDomainDnsRecord,
  SenderDomainVerificationStates,
} from '@sendmast/shared';

interface MailgunDomainResponse {
  domain?: {
    name?: string;
    state?: string;
    receiving_dns_records?: MailgunRecord[];
    sending_dns_records?: MailgunRecord[];
  };
  receiving_dns_records?: MailgunRecord[];
  sending_dns_records?: MailgunRecord[];
}

interface MailgunRecord {
  record_type?: string;
  type?: string;
  name?: string;
  hostname?: string;
  value?: string;
  valid?: string | boolean;
  is_active?: boolean;
}

@Injectable()
export class MailgunService {
  async createDomain(acct: EmailChannel, domain: string) {
    const payload = new URLSearchParams({ name: domain });
    const json = await this.request<MailgunDomainResponse>(acct, '/v4/domains', {
      method: 'POST',
      body: payload,
    });
    return {
      records: this.toRecords([
        ...(json.sending_dns_records ?? []),
        ...(json.receiving_dns_records ?? []),
        ...(json.domain?.sending_dns_records ?? []),
        ...(json.domain?.receiving_dns_records ?? []),
      ]),
    };
  }

  async getStates(acct: EmailChannel, domain: string): Promise<SenderDomainVerificationStates> {
    const json = await this.request<MailgunDomainResponse>(
      acct,
      `/v4/domains/${encodeURIComponent(domain)}`,
    );
    return this.toStates(json);
  }

  async verifyDomain(
    acct: EmailChannel,
    domain: string,
  ): Promise<SenderDomainVerificationStates> {
    const json = await this.request<MailgunDomainResponse>(
      acct,
      `/v4/domains/${encodeURIComponent(domain)}/verify`,
      { method: 'PUT' },
    );
    return this.toStates(json);
  }

  async deleteDomain(acct: EmailChannel, domain: string): Promise<void> {
    await this.request(acct, `/v3/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' });
  }

  private toStates(json: MailgunDomainResponse): SenderDomainVerificationStates {
    const records = this.responseRecords(json);
    const states: SenderDomainVerificationStates = {};
    for (const record of records) {
      const kind = this.recordKind(record);
      if (!kind) continue;
      const active = record.is_active === true || record.valid === true || record.valid === 'valid';
      states[kind] = { status: active ? 'Verified' : 'VerificationRequested' };
    }
    if (json.domain?.state === 'active') {
      for (const kind of ['Domain', 'SPF', 'DKIM', 'DKIM2'] as const) {
        states[kind] = { status: 'Verified' };
      }
    }
    return states;
  }

  private responseRecords(json: MailgunDomainResponse): MailgunRecord[] {
    return [
      ...(json.sending_dns_records ?? []),
      ...(json.receiving_dns_records ?? []),
      ...(json.domain?.sending_dns_records ?? []),
      ...(json.domain?.receiving_dns_records ?? []),
    ];
  }

  private toRecords(records: MailgunRecord[]): SenderDomainDnsRecord[] {
    const out = new Map<string, SenderDomainDnsRecord>();
    for (const r of records) {
      const kind = this.recordKind(r);
      const type = ((r.record_type ?? r.type ?? '').toUpperCase() || 'TXT') as 'TXT' | 'CNAME';
      const name = r.name ?? r.hostname;
      const value = r.value;
      if (!kind || !name || !value || (type !== 'TXT' && type !== 'CNAME')) continue;
      out.set(kind, { kind, type, name, value });
    }
    return [...out.values()];
  }

  private recordKind(record: MailgunRecord): SenderDomainDnsRecord['kind'] | null {
    const haystack = `${record.name ?? ''} ${record.hostname ?? ''} ${record.value ?? ''}`.toLowerCase();
    if (haystack.includes('_dmarc')) return 'DMARC';
    if (haystack.includes('spf')) return 'SPF';
    if (haystack.includes('domainkey')) return haystack.includes('k2') ? 'DKIM2' : 'DKIM';
    return 'Domain';
  }

  private async request<T = unknown>(
    acct: EmailChannel,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!acct.mailgunApiKey) throw new Error(`Mailgun channel ${acct.name}: API Key 未配置`);
    const base = (acct.mailgunApiBaseUrl || 'https://api.mailgun.net').replace(/\/+$/, '');
    const headers = new Headers(init.headers);
    headers.set(
      'Authorization',
      `Basic ${Buffer.from(`api:${acct.mailgunApiKey}`).toString('base64')}`,
    );
    if (init.body instanceof URLSearchParams) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      throw new Error(`Mailgun API ${res.status}: ${providerMessage(json, text)}`);
    }
    return json as T;
  }
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { body: text.slice(0, 4096) };
  }
}

function providerMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.message === 'string' ? payload.message : fallback;
}
