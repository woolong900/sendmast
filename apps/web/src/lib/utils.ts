import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return new Intl.NumberFormat('en-US').format(n);
}

/** Compact form: 1782 → "1782", 17400 → "17K", 49000 → "49K", 1_200_000 → "1.2M". */
export function formatCompactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n < 10_000) return new Intl.NumberFormat('en-US').format(n);
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatDateTime(s: string | Date | null | undefined): string {
  if (!s) return '-';
  const d = typeof s === 'string' ? new Date(s) : s;
  return d.toLocaleString('zh-CN', { hour12: false });
}
