import { Injectable } from '@nestjs/common';
import type { EmailChannel } from '@prisma/client';
import type {
  SenderDomainDnsRecord,
  SenderDomainVerificationStatus,
  SenderDomainVerificationStates,
} from '@sendmast/shared';

interface SendGridDomainResponse {
  id?: number | string;
  domain?: string;
  valid?: boolean;
  dns?: Record<string, SendGridDnsRecord | undefined>;
}

interface SendGridValidationResponse {
  id?: number | string;
  valid?: boolean;
  validation_results?: Record<string, SendGridValidationRecord | undefined>;
}

interface SendGridDnsRecord {
  type?: string;
  host?: string;
  data?: string;
  valid?: boolean;
}

interface SendGridValidationRecord {
  valid?: boolean;
  reason?: string;
}

@Injectable()
export class SendGridService {
  async createDomain(acct: EmailChannel, domain: string) {
    const json = await this.request<SendGridDomainResponse>(acct, '/v3/whitelabel/domains', {
      method: 'POST',
      body: JSON.stringify({
        domain,
        automatic_security: true,
      }),
    });
    return {
      providerDomainId: json.id == null ? null : String(json.id),
      records: this.toRecords(json.dns ?? {}),
      states: this.toStates(json),
    };
  }

  async verifyDomain(
    acct: EmailChannel,
    domainId: string,
  ): Promise<SenderDomainVerificationStates> {
    const json = await this.request<SendGridValidationResponse>(
      acct,
      `/v3/whitelabel/domains/${encodeURIComponent(domainId)}/validate`,
      { method: 'POST' },
    );
    return this.toStates(json);
  }

  async deleteDomain(acct: EmailChannel, domainId: string): Promise<void> {
    await this.request(acct, `/v3/whitelabel/domains/${encodeURIComponent(domainId)}`, {
      method: 'DELETE',
    });
  }

  private toRecords(records: Record<string, SendGridDnsRecord | undefined>): SenderDomainDnsRecord[] {
    const out: SenderDomainDnsRecord[] = [];
    for (const [key, r] of Object.entries(records)) {
      const kind = this.recordKind(key);
      const type = (r?.type ?? '').toUpperCase();
      if (!kind || type !== 'CNAME' || !r?.host || !r?.data) continue;
      out.push({
        kind,
        type,
        name: r.host,
        value: r.data,
      });
    }
    return out;
  }

  private toStates(
    json: SendGridDomainResponse | SendGridValidationResponse,
  ): SenderDomainVerificationStates {
    const states: SenderDomainVerificationStates = {};
    if ('validation_results' in json && json.validation_results) {
      for (const [key, record] of Object.entries(json.validation_results)) {
        const kind = this.recordKind(key);
        if (!kind) continue;
        states[kind] = { status: this.recordStatus(record?.valid) };
      }
    }
    if ('dns' in json && json.dns) {
      for (const [key, record] of Object.entries(json.dns)) {
        const kind = this.recordKind(key);
        if (!kind) continue;
        states[kind] = { status: this.recordStatus(record?.valid) };
      }
    }
    if (json.valid === true) {
      for (const kind of ['Domain', 'DKIM', 'DKIM2'] as const) {
        if (states[kind]) states[kind] = { status: 'Verified' };
      }
    }
    return states;
  }

  private recordKind(key: string): SenderDomainDnsRecord['kind'] | null {
    const normalised = key.toLowerCase();
    if (normalised === 'mail_cname' || normalised === 'mail') return 'Domain';
    if (normalised === 'dkim1') return 'DKIM';
    if (normalised === 'dkim2') return 'DKIM2';
    return null;
  }

  private recordStatus(valid: boolean | undefined): SenderDomainVerificationStatus {
    return valid === true ? 'Verified' : 'VerificationRequested';
  }

  private async request<T = unknown>(
    acct: EmailChannel,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!acct.sendgridApiKey) throw new Error(`SendGrid channel ${acct.name}: API Key 未配置`);
    const base = (acct.sendgridApiBaseUrl || 'https://api.sendgrid.com').replace(/\/+$/, '');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${acct.sendgridApiKey}`);
    headers.set('User-Agent', 'sendmast/1.0');
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      throw new Error(`SendGrid API ${res.status}: ${providerMessage(json, text)}`);
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
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors
      .map((err) => {
        if (!err || typeof err !== 'object') return String(err);
        return String((err as { message?: unknown }).message ?? JSON.stringify(err));
      })
      .join('; ');
  }
  if (typeof payload.message === 'string') return payload.message;
  return fallback;
}
