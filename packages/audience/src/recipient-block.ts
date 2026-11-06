function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Match an actual sender domain against an exact or wildcard domain rule. */
export function matchesSenderDomainPattern(domain: string, pattern: string): boolean {
  const normalizedDomain = domain.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedDomain || !normalizedPattern) return false;
  return globRegex(normalizedPattern).test(normalizedDomain);
}

/** Match a full email glob when the rule contains @, otherwise its domain only. */
export function matchesRecipientBlockPattern(email: string, pattern: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedEmail || !normalizedPattern) return false;
  const target = normalizedPattern.includes('@')
    ? normalizedEmail
    : (normalizedEmail.split('@')[1] ?? '');
  return globRegex(normalizedPattern).test(target);
}

export function isRecipientBlocked(email: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesRecipientBlockPattern(email, pattern));
}

export interface RecipientSendingRule {
  mode: 'allow' | 'block';
  recipientPattern: string;
}

/**
 * Block rules always win. When one or more allow rules apply to a sender
 * domain, the recipient must match at least one of them; no allow rules means
 * the sender remains unrestricted except for matching block rules.
 */
export function isRecipientBlockedBySendingRules(
  email: string,
  rules: readonly RecipientSendingRule[],
): boolean {
  const blockRules = rules.filter((rule) => rule.mode === 'block');
  if (blockRules.some((rule) => matchesRecipientBlockPattern(email, rule.recipientPattern))) {
    return true;
  }
  const allowRules = rules.filter((rule) => rule.mode === 'allow');
  return (
    allowRules.length > 0 &&
    !allowRules.some((rule) => matchesRecipientBlockPattern(email, rule.recipientPattern))
  );
}
