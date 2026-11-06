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
 * Allow rules win over block rules. When one or more allow rules apply to a
 * sender domain, a matching recipient is immediately allowed; a recipient
 * matching none of them is blocked even when no explicit block rule matches.
 */
export function isRecipientBlockedBySendingRules(
  email: string,
  rules: readonly RecipientSendingRule[],
): boolean {
  const allowRules = rules.filter((rule) => rule.mode === 'allow');
  if (allowRules.some((rule) => matchesRecipientBlockPattern(email, rule.recipientPattern))) {
    return false;
  }
  const blockRules = rules.filter((rule) => rule.mode === 'block');
  if (blockRules.some((rule) => matchesRecipientBlockPattern(email, rule.recipientPattern))) {
    return true;
  }
  return allowRules.length > 0;
}
