function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
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
