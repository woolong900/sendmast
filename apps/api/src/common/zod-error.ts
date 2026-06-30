import type { ZodError, ZodIssue } from 'zod';

/**
 * Pick the first issue from a ZodError and render it as a Chinese
 * "<label>: <message>" string. Used by controllers so that the user only
 * sees the *first* invalid field per request, rather than a wall of
 * combined errors.
 *
 * Field labels are mapped by `FIELD_LABELS` below. When a field is missing
 * from the table we fall back to the raw camelCase path — that's not
 * pretty, but it's better than crashing and tells you exactly which
 * mapping to add.
 */
export function firstZodError(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return '请求参数错误';
  const path = renderPath(issue.path);
  const label = labelOf(path);
  const msg = translate(issue);
  return label ? `${label}: ${msg}` : msg;
}

/**
 * Map of zod field path -> Chinese label that matches the form UI.
 * Add new entries here whenever a new request-body field is added to a
 * controller schema. Keys are usually the leaf field name; for fields
 * that genuinely mean different things in different forms, use the full
 * dot-path (e.g. "campaign.replyTo") and `labelOf` will prefer it.
 */
const FIELD_LABELS: Record<string, string> = {
  // generic
  name: '名称',
  status: '状态',
  email: '邮箱',
  description: '描述',

  // email channel
  rpsLimit: '每秒发送上限',
  rpmLimit: '每分发送上限',
  rphLimit: '每时发送上限',
  rpdLimit: '每日发送上限',
  azureTenantId: 'Tenant ID',
  azureClientId: 'Client ID',
  azureClientSecret: 'Client Secret',
  azureSubscriptionId: 'Subscription ID',
  azureResourceGroup: 'Resource Group',
  azureEmailServiceName: 'Email Service Name',

  // sender domain
  domain: '域名',
  emailChannelId: '邮件通道',
};

function labelOf(path: string): string {
  if (!path) return '';
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  const leaf = path.split('.').pop();
  if (leaf && FIELD_LABELS[leaf]) return FIELD_LABELS[leaf];
  return path;
}

function renderPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (out === '') {
      out = seg;
    } else {
      out += `.${seg}`;
    }
  }
  return out;
}

function translate(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.received === 'undefined' || issue.received === 'null') {
        return '必填';
      }
      return `类型错误（期望 ${issue.expected}，收到 ${issue.received}）`;
    }
    case 'too_small': {
      if (issue.type === 'string') {
        return issue.minimum === 1 ? '不能为空' : `长度至少 ${issue.minimum}`;
      }
      if (issue.type === 'number') return `不能小于 ${issue.minimum}`;
      if (issue.type === 'array') return `至少需要 ${issue.minimum} 项`;
      return '值过小';
    }
    case 'too_big': {
      if (issue.type === 'string') return `长度不能超过 ${issue.maximum}`;
      if (issue.type === 'number') return `不能大于 ${issue.maximum}`;
      if (issue.type === 'array') return `最多 ${issue.maximum} 项`;
      return '值过大';
    }
    case 'invalid_string': {
      const v = issue.validation;
      if (v === 'email') return '邮箱格式错误';
      if (v === 'uuid') return 'UUID 格式错误';
      if (v === 'url') return 'URL 格式错误';
      if (v === 'regex') return '格式不匹配';
      return '字符串格式错误';
    }
    case 'invalid_enum_value': {
      const opts = (issue.options ?? []).join(', ');
      return opts ? `取值不合法（允许：${opts}）` : '取值不合法';
    }
    case 'unrecognized_keys': {
      const keys = (issue.keys ?? []).join(', ');
      return keys ? `存在不允许的字段：${keys}` : '存在不允许的字段';
    }
    case 'invalid_union':
      return '不符合任一允许的格式';
    case 'invalid_date':
      return '日期格式错误';
    case 'not_finite':
      return '必须是有限数';
    case 'custom':
      return issue.message || '校验失败';
    default:
      return issue.message || '校验失败';
  }
}
