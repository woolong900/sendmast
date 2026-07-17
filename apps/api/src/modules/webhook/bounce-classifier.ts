/**
 * Phrases (and enhanced status codes) that confidently mean "the RECIPIENT
 * mailbox itself is unusable" — i.e. a real 无效邮箱 we should suppress. Matched
 * case-insensitively as plain substrings against the failure message.
 *
 * Deliberately narrow. A bare 5xx is NOT enough: most of our 5xx bounces are
 * sender-side policy / reputation / DNS blocks (e.g. Gmail 550-5.7.1 "low
 * reputation of the sending domain", "Sender verify failed", "no A/AAAA/MX
 * records"), where the recipient address is perfectly fine. Treating those as
 * hard would suppress good contacts over OUR deliverability problem.
 */
const HARD_BOUNCE_SIGNALS = [
  '5.1.1', // enhanced status: bad destination mailbox (no such user)
  '5.1.10', // null MX / recipient does not exist (Office365)
  'does not exist',
  'user unknown',
  'unknown user',
  'no such user',
  'no such recipient',
  'no such mailbox',
  'user not found',
  'mailbox not found',
  'address not found',
  'invalid recipient',
  'unknown recipient',
  'recipient unknown',
  'recipient address rejected', // Exchange/O365 550 5.1.1 RecipNotFound (real bad address)
  // NOTE: bare "recipient rejected" is intentionally NOT here. Charter/Spectrum
  // (*.rr.com, charter.net, roadrunner.com, twc.com, bresnan.net) emit
  // "<addr> recipient rejected};{MSG=};{FQDN=...charter.net};{IP=...}" with NO
  // SMTP/enhanced code as an IP/reputation block, not a bad-mailbox signal.
  // Treating it as hard would suppress good contacts over our deliverability.
  'not a valid user', // e.g. "x@y is not a valid user"
  'mailbox is disabled', // Yahoo 554.30 — account deactivated
  'account is disabled',
  'is inactive', // Gmail 5.2.1 — "account that you tried to reach is inactive"
];

/**
 * Phrases that mean the failure is about OUR sending side (the sender domain /
 * MAIL FROM / reputation), NOT the recipient mailbox. These take priority over
 * HARD_BOUNCE_SIGNALS because some sender-side rejections reuse mailbox wording,
 * e.g. "Domain of sender address postal@… does not exist" or "Sender verify
 * failed" — there "does not exist" refers to our domain, not the recipient.
 */
const SENDER_SIDE_SIGNALS = ['sender', 'mail from', 'reputation'];

/**
 * Phrases that indicate the recipient server rejected the message for policy,
 * content, authentication, DNS, rate-limit, or sender reputation reasons. These
 * are deliverability problems, not proof that the destination mailbox is dead.
 */
const POLICY_OR_CONTENT_SIGNALS = [
  'content denied',
  'mail content denied',
  'message blocked',
  'message rejected',
  'policy',
  'spam',
  'abuse',
  'blacklist',
  'blocklist',
  'reputation',
  'rate limit',
  'throttl',
  'dns',
  'dkim',
  'spf',
  'dmarc',
];

/**
 * Classify a bounce as a permanent recipient failure ('hard') vs. anything else
 * ('soft').
 *
 *   1. Any sender-side signal (it's our domain/reputation problem) -> 'soft'.
 *   2. Otherwise a HARD_BOUNCE_SIGNAL (recipient mailbox unusable) -> 'hard'.
 *   3. Otherwise (transient 4xx, code-less, policy blocks) -> 'soft'.
 *
 * We default to soft so we never over-suppress a good recipient over our own
 * deliverability problem. Only 'hard' drives suppression downstream
 * (worker-events).
 *
 * Source: data.deliveryStatusDetails.statusMessage — free-form, often
 * "550 5.1.1 user unknown" or "550 5.7.1 ... message blocked".
 */
export function classifyBounce(data: Record<string, unknown>): 'hard' | 'soft' {
  const msg = String(
    (data as { deliveryStatusDetails?: { statusMessage?: string } }).deliveryStatusDetails
      ?.statusMessage ?? '',
  ).toLowerCase();
  if (SENDER_SIDE_SIGNALS.some((s) => msg.includes(s))) return 'soft';
  if (POLICY_OR_CONTENT_SIGNALS.some((s) => msg.includes(s))) return 'soft';
  return HARD_BOUNCE_SIGNALS.some((s) => msg.includes(s)) ? 'hard' : 'soft';
}

/**
 * Mailgun's top-level `severity=permanent` is too broad for suppression: a
 * 550 content/policy rejection can be permanent for that message while the
 * recipient mailbox is perfectly valid. Prefer Mailgun's delivery-status
 * bounce-type when it says soft, then fall back to the same narrow recipient
 * failure signals used for ACS.
 */
export function classifyMailgunBounce(data: Record<string, unknown>): 'hard' | 'soft' {
  const deliveryStatus = data['delivery-status'] as Record<string, unknown> | undefined;
  const bounceType = String(deliveryStatus?.['bounce-type'] ?? '').toLowerCase();
  if (bounceType.includes('soft') || bounceType.includes('temporary')) return 'soft';

  const message = String(deliveryStatus?.message ?? '').toLowerCase();
  const enhancedCode = String(deliveryStatus?.['enhanced-code'] ?? '').toLowerCase();
  const description = String(deliveryStatus?.description ?? '').toLowerCase();
  const reason = String(data.reason ?? '').toLowerCase();
  const combined = [message, enhancedCode, description, reason].filter(Boolean).join(' ');

  if (SENDER_SIDE_SIGNALS.some((s) => combined.includes(s))) return 'soft';
  if (POLICY_OR_CONTENT_SIGNALS.some((s) => combined.includes(s))) return 'soft';
  return HARD_BOUNCE_SIGNALS.some((s) => combined.includes(s)) ? 'hard' : 'soft';
}
