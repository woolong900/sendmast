import { ClientSecretCredential } from '@azure/identity';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { EmailClient } from '@azure/communication-email';
import type { AcsAccount } from '@prisma/client';

export interface MailMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
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
 * Cache key includes fields whose change must invalidate a cached transport
 * (credentials, target Communication Service). The endpoint hostName itself is
 * an immutable Azure resource property, so we discover it once via ARM and
 * reuse it for the lifetime of the cached transport.
 */
function cacheKey(acct: AcsAccount): string {
  return [
    acct.id,
    acct.azureTenantId,
    acct.azureClientId,
    acct.azureSubscriptionId,
    acct.azureResourceGroup,
    acct.azureCommunicationServiceName ?? '',
    acct.azureClientSecret.slice(0, 8),
  ].join('|');
}

const cache = new Map<string, Promise<MailTransport>>();

export function getTransportForAccount(acct: AcsAccount): Promise<MailTransport> {
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

async function buildTransport(acct: AcsAccount): Promise<MailTransport> {
  if (!acct.azureCommunicationServiceName) {
    throw new Error(
      `ACS account ${acct.name}: azureCommunicationServiceName is not configured`,
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
      `ACS account ${acct.name}: Communication Service ${acct.azureCommunicationServiceName} has no hostName`,
    );
  }

  const endpoint = hostName.startsWith('http') ? hostName : `https://${hostName}`;
  const client = new EmailClient(endpoint, credential);

  return {
    async send(msg) {
      const startedAt = Date.now();
      try {
        const poller = await client.beginSend({
          senderAddress: msg.from.address,
          recipients: { to: [{ address: msg.to }] },
          content: { subject: msg.subject, html: msg.html },
          headers: msg.headers,
        });
        const result = await poller.pollUntilDone();
        const latencyMs = Date.now() - startedAt;
        const status = result.status ?? 'Unknown';
        if (status === 'Succeeded') {
          return {
            ok: true,
            messageId: result.id ?? '',
            providerStatus: status,
            latencyMs,
            providerResponse: { id: result.id, status },
          };
        }
        // LRO terminated with non-Succeeded (Failed / Canceled).
        return {
          ok: false,
          messageId: result.id ?? '',
          providerStatus: status,
          latencyMs,
          errorCode: result.error?.code,
          errorMessage: result.error?.message ?? `ACS LRO 异常结束，status=${status}`,
          providerResponse: { id: result.id, status, error: result.error },
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
