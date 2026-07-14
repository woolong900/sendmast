import { ClientSecretCredential } from '@azure/identity';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { EmailClient } from '@azure/communication-email';
import type { EmailChannel } from '@prisma/client';

export interface MailMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  /**
   * Client-supplied ACS operation id. ACS echoes it back as `result.id` AND as
   * the `messageId` in delivery reports, so we pre-assign it (and persist it on
   * the recipient before sending) to close the race where a fast bounce report
   * arrives before we'd otherwise have written messageId. Reusing the same id
   * on a retried send also makes the send idempotent (no duplicate email).
   */
  operationId?: string;
}

/**
 * Result of a single ACS send call. We always resolve (never reject) so the
 * caller can persist a complete provider trace whether the call succeeded or
 * failed. The caller decides whether to surface a BullMQ failure based on `ok`.
 */
export interface SendResult {
  ok: boolean;
  messageId: string;
  /** ACS LRO terminal status, or `Http<status>` / `Error` when the SDK threw. */
  providerStatus: string;
  /** Wall-clock time spent inside the ACS call, ms. */
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
  /** Raw response body or sanitised error object — written into JSONB. */
  providerResponse?: unknown;
}

export interface MailTransport {
  send(msg: MailMessage): Promise<SendResult>;
}

/**
 * Hard ceiling on a single ACS `beginSend` call. ACS's send endpoint can hang
 * indefinitely during a service-side incident; without a timeout one stuck
 * call permanently occupies a worker slot and, at concurrency N, N hangs
 * freeze the entire send pipeline. We bound it so a hang becomes a fast failure
 * instead of a freeze.
 */
const SEND_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Cache key includes fields whose change must invalidate a cached transport
 * (credentials, target Communication Service). The endpoint hostName itself is
 * an immutable Azure resource property, so we discover it once via ARM and
 * reuse it for the lifetime of the cached transport.
 */
function cacheKey(acct: EmailChannel): string {
  return [
    acct.id,
    acct.provider,
    acct.azureTenantId,
    acct.azureClientId,
    acct.azureSubscriptionId,
    acct.azureResourceGroup,
    acct.azureCommunicationServiceName ?? '',
    acct.azureClientSecret.slice(0, 8),
    acct.mailgunApiBaseUrl ?? '',
    acct.mailgunApiKey?.slice(0, 8) ?? '',
    acct.resendApiBaseUrl ?? '',
    acct.resendApiKey?.slice(0, 8) ?? '',
  ].join('|');
}

const cache = new Map<string, Promise<MailTransport>>();

export function getTransportForAccount(acct: EmailChannel): Promise<MailTransport> {
  const key = cacheKey(acct);
  let entry = cache.get(key);
  if (!entry) {
    entry = buildTransport(acct).catch((err) => {
      // Don't poison the cache with a failed build — next send retries.
      cache.delete(key);
      throw err;
    });
    cache.set(key, entry);
  }
  return entry;
}

async function buildTransport(acct: EmailChannel): Promise<MailTransport> {
  if (acct.provider === 'mailgun') return buildMailgunTransport(acct);
  if (acct.provider === 'resend') return buildResendTransport(acct);
  return buildEmailChannelTransport(acct);
}

async function buildEmailChannelTransport(acct: EmailChannel): Promise<MailTransport> {
  if (!acct.azureCommunicationServiceName) {
    throw new Error(
      `Azure ACS channel ${acct.name}: azureCommunicationServiceName is not configured`,
    );
  }

  const credential = new ClientSecretCredential(
    acct.azureTenantId,
    acct.azureClientId,
    acct.azureClientSecret,
  );

  const arm = new CommunicationServiceManagementClient(credential, acct.azureSubscriptionId);
  const resource = await arm.communicationServices.get(
    acct.azureResourceGroup,
    acct.azureCommunicationServiceName,
  );
  const hostName = resource.hostName;
  if (!hostName) {
    throw new Error(
      `Azure ACS channel ${acct.name}: Communication Service ${acct.azureCommunicationServiceName} has no hostName`,
    );
  }

  const endpoint = hostName.startsWith('http') ? hostName : `https://${hostName}`;
  const client = new EmailClient(endpoint, credential);

  return {
    async send(msg) {
      const startedAt = Date.now();
      try {
        // ACS email send is async: `beginSend` resolving means ACS ACCEPTED
        // the request (HTTP 202). We deliberately do NOT `pollUntilDone()` —
        // waiting for the LRO to reach "Succeeded" costs ~6s per send and caps
        // throughput at concurrency÷latency (~1.3/s with 8 workers). The
        // terminal delivery/bounce result arrives out-of-band via Event Grid,
        // keyed by the operationId we pre-assign, so polling yields no
        // information we don't already receive asynchronously — it is pure
        // latency. Submission-time failures (auth, 429, invalid recipient)
        // still throw from beginSend and are handled in the catch below.
        await withTimeout(
          client.beginSend(
            {
              senderAddress: msg.from.address,
              recipients: { to: [{ address: msg.to }] },
              content: { subject: msg.subject, html: msg.html },
              headers: msg.headers,
            },
            msg.operationId ? { operationId: msg.operationId } : undefined,
          ),
          SEND_TIMEOUT_MS,
          'ACS beginSend',
        );
        const latencyMs = Date.now() - startedAt;
        // operationId is the id ACS echoes back as the delivery-report
        // messageId; the caller (worker-sender) always supplies it.
        const messageId = msg.operationId ?? '';
        return {
          ok: true,
          messageId,
          providerStatus: 'Accepted',
          latencyMs,
          providerResponse: { operationId: messageId, accepted: true },
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const sanitised = serialiseError(err);
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const code = (err as { code?: string })?.code;
        const message =
          (err as { message?: string })?.message ?? (err instanceof Error ? err.message : String(err));
        return {
          ok: false,
          messageId: '',
          providerStatus: statusCode ? `Http${statusCode}` : 'Error',
          latencyMs,
          errorCode: code,
          errorMessage: message,
          providerResponse: sanitised,
        };
      }
    },
  };
}

function buildMailgunTransport(acct: EmailChannel): MailTransport {
  if (!acct.mailgunApiKey) {
    throw new Error(`Mailgun channel ${acct.name}: API Key is not configured`);
  }
  const base = (acct.mailgunApiBaseUrl || 'https://api.mailgun.net').replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`api:${acct.mailgunApiKey}`).toString('base64')}`;

  return {
    async send(msg) {
      const startedAt = Date.now();
      const domain = msg.from.address.split('@')[1]?.toLowerCase();
      if (!domain) {
        return {
          ok: false,
          messageId: '',
          providerStatus: 'Error',
          latencyMs: Date.now() - startedAt,
          errorMessage: `Invalid sender address: ${msg.from.address}`,
        };
      }

      try {
        const body = new URLSearchParams({
          from: formatFrom(msg.from.name, msg.from.address),
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
        });
        for (const [key, value] of Object.entries(msg.headers ?? {})) {
          body.set(`h:${key}`, value);
        }
        if (msg.operationId) body.set('h:X-SendMast-Operation-Id', msg.operationId);
        const variables = mailgunVariables(msg.headers ?? {}, msg.operationId);
        for (const [key, value] of Object.entries(variables)) {
          body.set(`v:${key}`, value);
        }

        const res = await withTimeout(
          fetch(`${base}/v3/${encodeURIComponent(domain)}/messages`, {
            method: 'POST',
            headers: {
              Authorization: auth,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          }),
          SEND_TIMEOUT_MS,
          'Mailgun send',
        );
        const text = await res.text();
        const payload = parseJson(text);
        const latencyMs = Date.now() - startedAt;
        if (!res.ok) {
          return {
            ok: false,
            messageId: '',
            providerStatus: `Http${res.status}`,
            latencyMs,
            errorMessage: providerMessage(payload, text),
            providerResponse: payload,
          };
        }
        return {
          ok: true,
          messageId:
            typeof payload === 'object' && payload && 'id' in payload
              ? String((payload as { id?: unknown }).id ?? msg.operationId ?? '')
              : msg.operationId ?? '',
          providerStatus: 'Accepted',
          latencyMs,
          providerResponse: payload,
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        return {
          ok: false,
          messageId: '',
          providerStatus: 'Error',
          latencyMs,
          errorCode: (err as { code?: string })?.code,
          errorMessage: err instanceof Error ? err.message : String(err),
          providerResponse: serialiseError(err),
        };
      }
    },
  };
}

function buildResendTransport(acct: EmailChannel): MailTransport {
  if (!acct.resendApiKey) {
    throw new Error(`Resend channel ${acct.name}: API Key is not configured`);
  }
  const base = (acct.resendApiBaseUrl || 'https://api.resend.com').replace(/\/+$/, '');

  return {
    async send(msg) {
      const startedAt = Date.now();
      try {
        const headers = { ...(msg.headers ?? {}) };
        if (msg.operationId) headers['X-SendMast-Operation-Id'] = msg.operationId;
        const res = await withTimeout(
          fetch(`${base}/emails`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${acct.resendApiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': 'sendmast/1.0',
              ...(msg.operationId ? { 'Idempotency-Key': msg.operationId } : {}),
            },
            body: JSON.stringify({
              from: formatFrom(msg.from.name, msg.from.address),
              to: [msg.to],
              subject: msg.subject,
              html: msg.html,
              headers,
              tags: resendTags(msg.headers ?? {}, msg.operationId),
            }),
          }),
          SEND_TIMEOUT_MS,
          'Resend send',
        );
        const text = await res.text();
        const payload = parseJson(text);
        const latencyMs = Date.now() - startedAt;
        if (!res.ok) {
          return {
            ok: false,
            messageId: '',
            providerStatus: `Http${res.status}`,
            latencyMs,
            errorMessage: providerMessage(payload, text),
            providerResponse: payload,
          };
        }
        return {
          ok: true,
          messageId:
            typeof payload === 'object' && payload && 'id' in payload
              ? String((payload as { id?: unknown }).id ?? msg.operationId ?? '')
              : msg.operationId ?? '',
          providerStatus: 'Accepted',
          latencyMs,
          providerResponse: payload,
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        return {
          ok: false,
          messageId: '',
          providerStatus: 'Error',
          latencyMs,
          errorCode: (err as { code?: string })?.code,
          errorMessage: err instanceof Error ? err.message : String(err),
          providerResponse: serialiseError(err),
        };
      }
    },
  };
}

function mailgunVariables(
  headers: Record<string, string>,
  operationId?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers['X-SendMast-Recipient']) out.sendmast_recipient_id = headers['X-SendMast-Recipient'];
  if (headers['X-SendMast-Campaign']) out.sendmast_campaign_id = headers['X-SendMast-Campaign'];
  if (headers['X-SendMast-FlowSend']) {
    out.sendmast_recipient_id = headers['X-SendMast-FlowSend'];
    out.sendmast_source = 'a';
  }
  if (headers['X-SendMast-Automation']) out.sendmast_automation_id = headers['X-SendMast-Automation'];
  if (operationId) out.sendmast_operation_id = operationId;
  return out;
}

function resendTags(
  headers: Record<string, string>,
  operationId?: string,
): Array<{ name: string; value: string }> {
  return Object.entries(mailgunVariables(headers, operationId))
    .map(([name, value]) => ({
      name: sanitiseResendTagPart(name),
      value: sanitiseResendTagPart(value),
    }))
    .filter((tag) => tag.name && tag.value);
}

function sanitiseResendTagPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256);
}

function formatFrom(name: string, address: string): string {
  const trimmed = name.trim();
  if (!trimmed) return address;
  return `"${trimmed.replace(/"/g, '\\"')}" <${address}>`;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { body: text.slice(0, 4096) };
  }
}

function providerMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    return String((payload as { message?: unknown }).message ?? fallback);
  }
  if (payload && typeof payload === 'object' && 'name' in payload) {
    return String((payload as { name?: unknown }).name ?? fallback);
  }
  return fallback;
}

/**
 * Convert ACS SDK errors (often `RestError` with circular `request`/`response`
 * graphs) into a plain JSON-serialisable object. We cherry-pick the fields
 * useful for debugging and cap any free-text body to keep row size bounded.
 */
function serialiseError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return { message: String(err) };
  const e = err as Record<string, unknown>;
  const response = e.response as Record<string, unknown> | undefined;
  const bodyText =
    typeof response?.bodyAsText === 'string'
      ? (response.bodyAsText as string).slice(0, 4096)
      : undefined;
  return {
    name: e.name,
    code: e.code,
    statusCode: e.statusCode,
    message: e.message,
    details: e.details,
    additionalInfo: e.additionalInfo,
    response: response
      ? {
          status: response.status,
          headers: response.headers,
          bodyAsText: bodyText,
        }
      : undefined,
  };
}
