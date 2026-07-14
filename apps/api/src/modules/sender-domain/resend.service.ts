import { Injectable } from '@nestjs/common';
import type { EmailChannel } from '@prisma/client';
import type {
  SenderDomainDnsRecord,
  SenderDomainVerificationStatus,
  SenderDomainVerificationStates,
} from '@sendmast/shared';

interface ResendDomainResponse {
  id?: string;
  name?: string;
  status?: string;
  records?: ResendRecord[];
}

interface ResendRecord {
  record?: string;
  name?: string;
  value?: string;
  type?: string;
  ttl?: string | number;
  status?: string;
  priority?: number;
}

@Injectable()
export class ResendService {
  async createDomain(acct: EmailChannel, domain: string) {
    const json = await this.request<ResendDomainResponse>(acct, '/domains', {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    });
    return {
      providerDomainId: json.id ?? null,
      records: this.toRecords(json.records ?? []),
    };
  }

  async verifyDomain(
    acct: EmailChannel,
    domainId: string,
  ): Promise<SenderDomainVerificationStates> {
    await this.request(acct, `/domains/${encodeURIComponent(domainId)}/verify`, {
      method: 'POST',
    });
    const json = await this.getDomain(acct, domainId);
    return this.toStates(json);
  }

  async getDomain(acct: EmailChannel, domainId: string): Promise<ResendDomainResponse> {
    return this.request<ResendDomainResponse>(acct, `/domains/${encodeURIComponent(domainId)}`);
  }

  async deleteDomain(acct: EmailChannel, domainId: string): Promise<void> {
    await this.request(acct, `/domains/${encodeURIComponent(domainId)}`, { method: 'DELETE' });
  }

  toStates(json: ResendDomainResponse): SenderDomainVerificationStates {
    const grouped = new Map<SenderDomainDnsRecord['kind'], SenderDomainVerificationStatus[]>();
    let dkimCount = 0;
    for (const record of json.records ?? []) {
      const kind = this.recordKind(record, dkimCount);
      if (!kind) continue;
      if (kind === 'DKIM') dkimCount += 1;
      if (kind === 'DKIM2') dkimCount += 1;
      grouped.set(kind, [...(grouped.get(kind) ?? []), this.recordStatus(record.status)]);
    }

    const states: SenderDomainVerificationStates = {};
    for (const [kind, statuses] of grouped.entries()) {
      states[kind] = { status: aggregateStatuses(statuses) };
    }
    if (json.status === 'verified') {
      for (const kind of ['Domain', 'SPF', 'DKIM', 'DKIM2', 'Tracking'] as const) {
        if (states[kind]) states[kind] = { status: 'Verified' };
      }
    }
    return states;
  }

  private toRecords(records: ResendRecord[]): SenderDomainDnsRecord[] {
    const out: SenderDomainDnsRecord[] = [];
    let dkimCount = 0;
    for (const r of records) {
      const kind = this.recordKind(r, dkimCount);
      const type = (r.type ?? '').toUpperCase();
      if (!kind || (type !== 'TXT' && type !== 'CNAME' && type !== 'MX') || !r.name || !r.value) {
        continue;
      }
      if (kind === 'DKIM') dkimCount += 1;
      out.push({
        kind,
        type,
        name: r.name,
        value: r.value,
        ttl: typeof r.ttl === 'number' ? r.ttl : undefined,
        priority: typeof r.priority === 'number' ? r.priority : undefined,
      });
    }
    return out;
  }

  private recordKind(record: ResendRecord, dkimCount = 0): SenderDomainDnsRecord['kind'] | null {
    const label = (record.record ?? '').toLowerCase();
    if (label === 'spf') return 'SPF';
    if (label === 'dkim') return dkimCount === 0 ? 'DKIM' : 'DKIM2';
    if (label === 'tracking') return 'Tracking';
    if (label === 'domain') return 'Domain';
    const haystack = `${record.name ?? ''} ${record.value ?? ''}`.toLowerCase();
    if (haystack.includes('_dmarc')) return 'DMARC';
    return null;
  }

  private recordStatus(status: string | undefined): SenderDomainVerificationStatus {
    switch ((status ?? '').toLowerCase()) {
      case 'verified':
        return 'Verified';
      case 'not_started':
        return 'NotStarted';
      case 'failed':
      case 'temporary_failure':
      case 'failure':
        return 'VerificationFailed';
      case 'pending':
        return 'VerificationRequested';
      default:
        return 'Unknown';
    }
  }

  private async request<T = unknown>(
    acct: EmailChannel,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!acct.resendApiKey) throw new Error(`Resend channel ${acct.name}: API Key 未配置`);
    const base = (acct.resendApiBaseUrl || 'https://api.resend.com').replace(/\/+$/, '');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${acct.resendApiKey}`);
    headers.set('User-Agent', 'sendmast/1.0');
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      throw new Error(`Resend API ${res.status}: ${providerMessage(json, text)}`);
    }
    return json as T;
  }
}

function aggregateStatuses(statuses: SenderDomainVerificationStatus[]): SenderDomainVerificationStatus {
  if (statuses.length === 0) return 'Unknown';
  if (statuses.every((s) => s === 'Verified')) return 'Verified';
  if (statuses.some((s) => s === 'VerificationFailed')) return 'VerificationFailed';
  if (statuses.some((s) => s === 'VerificationRequested')) return 'VerificationRequested';
  if (statuses.every((s) => s === 'NotStarted')) return 'NotStarted';
  return 'Unknown';
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
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.name === 'string') return payload.name;
  return fallback;
}
