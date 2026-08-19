import { createHash, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EmailChannel } from '@prisma/client';
import type {
  SenderDomainDnsRecord,
  SenderDomainVerificationStatus,
  SenderDomainVerificationStates,
} from '@sendmast/shared';

interface SesIdentityResponse {
  IdentityType?: string;
  VerifiedForSendingStatus?: boolean;
  DkimAttributes?: {
    Status?: string;
    Tokens?: string[];
    SigningAttributesOrigin?: string;
  };
}

@Injectable()
export class SesService {
  async createDomain(acct: EmailChannel, domain: string) {
    const json = await this.request<SesIdentityResponse>(acct, '/v2/email/identities', {
      method: 'POST',
      body: JSON.stringify({ EmailIdentity: domain }),
    });
    return {
      records: this.toRecords(json.DkimAttributes?.Tokens ?? []),
      states: this.toStates(json),
    };
  }

  async verifyDomain(acct: EmailChannel, domain: string): Promise<SenderDomainVerificationStates> {
    const json = await this.request<SesIdentityResponse>(
      acct,
      `/v2/email/identities/${encodeURIComponent(domain)}`,
    );
    return this.toStates(json);
  }

  async deleteDomain(acct: EmailChannel, domain: string): Promise<void> {
    await this.request(acct, `/v2/email/identities/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
  }

  private toRecords(tokens: string[]): SenderDomainDnsRecord[] {
    return tokens.slice(0, 3).map((token, index) => ({
      kind: (['DKIM', 'DKIM2', 'DKIM3'] as const)[index],
      type: 'CNAME',
      name: `${token}._domainkey`,
      value: `${token}.dkim.amazonses.com`,
    }));
  }

  private toStates(json: SesIdentityResponse): SenderDomainVerificationStates {
    const status = this.recordStatus(
      json.VerifiedForSendingStatus === true || json.DkimAttributes?.Status === 'SUCCESS',
    );
    const states: SenderDomainVerificationStates = {};
    for (const kind of ['DKIM', 'DKIM2', 'DKIM3'] as const) {
      states[kind] = { status };
    }
    return states;
  }

  private recordStatus(verified: boolean): SenderDomainVerificationStatus {
    return verified ? 'Verified' : 'VerificationRequested';
  }

  private async request<T = unknown>(
    acct: EmailChannel,
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    if (!acct.sesAccessKeyId) throw new Error(`SES channel ${acct.name}: Access Key ID 未配置`);
    if (!acct.sesSecretAccessKey) throw new Error(`SES channel ${acct.name}: Secret Access Key 未配置`);
    const region = acct.sesRegion || 'us-east-1';
    const url = `https://email.${region}.amazonaws.com${path}`;
    const method = init.method ?? 'GET';
    const body = init.body ?? '';
    const headers = signAwsRequest({
      accessKeyId: acct.sesAccessKeyId,
      secretAccessKey: acct.sesSecretAccessKey,
      region,
      service: 'ses',
      method,
      url,
      body,
      headers: body ? { 'content-type': 'application/json' } : {},
    });
    const res = await fetch(url, { method, headers, body: body || undefined });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      throw new Error(`SES API ${res.status}: ${providerMessage(json, text)}`);
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
  return String(payload.message ?? payload.Message ?? payload.__type ?? fallback);
}

function signAwsRequest(params: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(params.url);
  const payloadHash = sha256Hex(params.body);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}`)
    .join('\n');
  const signedHeaders = sortedHeaderNames.join(';');
  const canonicalRequest = [
    params.method.toUpperCase(),
    url.pathname || '/',
    url.searchParams.toString(),
    canonicalHeaders + '\n',
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = awsSigningKey(params.secretAccessKey, dateStamp, params.region, params.service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
