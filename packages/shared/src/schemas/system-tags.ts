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
    description: '该收件人所属的列表名称（仅限本次活动发送的列表）；属于多个时取所选列表中的第一个，仅经分群命中时为空',
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
  {
    name: 'order_no',
    placeholder: '{{order_no}}',
    label: '订单号',
    description: '电商自动化邮件专用：触发订单的订单号（仅订单/弃单自动化邮件中有值）',
  },
  {
    name: 'order_total',
    placeholder: '{{order_total}}',
    label: '订单金额',
    description: '电商自动化邮件专用：订单金额（含货币符号，如 US$59.00）',
  },
  {
    name: 'order_currency',
    placeholder: '{{order_currency}}',
    label: '订单货币',
    description: '电商自动化邮件专用：订单货币代码（如 USD）',
  },
  {
    name: 'tracking_url',
    placeholder: '{{tracking_url}}',
    label: '物流追踪链接',
    description: '电商自动化邮件专用：发货通知中的物流追踪 URL',
  },
  {
    name: 'order_items',
    placeholder: '{{order_items}}',
    label: '商品列表',
    description:
      '电商自动化邮件专用：订单内商品列表（图片+名称+数量），由系统渲染为 HTML 整段插入（仅订单/弃单自动化邮件中有值）',
  },
] as const;

/** Whitelist tag names; used to build the substitution regex. */
export const SYSTEM_TAG_NAMES = SYSTEM_TAGS.map((t) => t.name);

/**
 * System tags whose value is supplied per-recipient via `mergeVars` (rather
 * than derived from contact/campaign). Used by the transactional automation
 * path; always empty for ordinary bulk-campaign recipients.
 */
export const MERGE_VAR_TAG_NAMES = [
  'order_no',
  'order_total',
  'order_currency',
  'tracking_url',
] as const;

/**
 * Merge-var tags whose value is a pre-rendered, trusted HTML fragment (built
 * server-side with its dynamic text already escaped). worker-sender injects
 * these verbatim instead of HTML-escaping them — otherwise the markup would
 * render as literal text in the inbox. Treated as a merge var (per-recipient,
 * blank on bulk campaigns) like MERGE_VAR_TAG_NAMES.
 */
export const HTML_MERGE_VAR_TAG_NAMES = ['order_items'] as const;
