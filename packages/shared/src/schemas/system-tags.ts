/**
 * System tags — fixed, account-agnostic placeholders that worker-sender
 * substitutes per recipient at send time. Double-brace syntax `{{name}}`,
 * matching custom tags' family but without the `tag:` prefix.
 *
 * Coexistence with custom tags:
 * - System: `{{name}}` where `name` ∈ SYSTEM_TAG_NAMES (strict whitelist).
 * - Custom: `{{tag:name}}` where `name` is user-defined.
 * The two regexes are disjoint (`tag:` prefix prevents overlap), so there's
 * no resolution-order ambiguity even if a customer happens to define a
 * custom tag named `first_name`.
 *
 * The frontend imports SYSTEM_TAGS to render the variable-helper UI
 * (insert hints in the wizard); worker-sender imports it to keep the
 * substitution regex in sync. Single source of truth.
 */

export interface SystemTagDef {
  /** Placeholder name without braces, e.g. `first_name`. */
  name: string;
  /** Inserted form, e.g. `{{first_name}}`. */
  placeholder: string;
  /** Short Chinese label for UI lists. */
  label: string;
  /** One-sentence description (Chinese). */
  description: string;
}

export const SYSTEM_TAGS: readonly SystemTagDef[] = [
  {
    name: 'first_name',
    placeholder: '{{first_name}}',
    label: '名',
    description: '收件人的名字（First Name），未填则为空',
  },
  {
    name: 'last_name',
    placeholder: '{{last_name}}',
    label: '姓',
    description: '收件人的姓氏（Last Name），未填则为空',
  },
  {
    name: 'full_name',
    placeholder: '{{full_name}}',
    label: '全名',
    description: '姓 + 名拼接；姓名都为空时回退到邮箱用户名部分',
  },
  {
    name: 'email',
    placeholder: '{{email}}',
    label: '邮箱',
    description: '收件人的邮箱地址',
  },
  {
    name: 'campaign_id',
    placeholder: '{{campaign_id}}',
    label: '活动 ID',
    description: '当前活动的 UUID',
  },
  {
    name: 'campaign_name',
    placeholder: '{{campaign_name}}',
    label: '活动名',
    description: '当前活动的名称',
  },
  {
    name: 'list_name',
    placeholder: '{{list_name}}',
    label: '列表名',
    description: '该收件人所属的列表名称（仅限本次活动发送的列表）；属于多个时以「、」连接，仅经分群命中时为空',
  },
  {
    name: 'date',
    placeholder: '{{date}}',
    label: '日期',
    description: '邮件发送日期（UTC，格式 MMDD，如 0603）',
  },
  {
    name: 'sender_domain',
    placeholder: '{{sender_domain}}',
    label: '发件域名',
    description: '发件人邮箱的域名部分',
  },
  {
    name: 'unsubscribe_url',
    placeholder: '{{unsubscribe_url}}',
    label: '退订链接',
    description: '该收件人专属的退订 URL，建议放在 <a href="..."> 里',
  },
] as const;

/** Whitelist tag names; used to build the substitution regex. */
export const SYSTEM_TAG_NAMES = SYSTEM_TAGS.map((t) => t.name);
