import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Sparkles, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { FilterMultiSelect, FilterSelect } from '@/components/ui/filter-select';
import {
  DateRangePicker,
  type DateRange,
} from '@/components/ui/date-range-picker';
import { api, apiErrMessage } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import type {
  SegmentDefinition,
  SegmentPreviewResult,
  SegmentRule,
  SegmentView,
} from '@sendmast/shared';

// ---------------------------------------------------------------------------
// External data sources for rule editors (lists / campaigns).
// ---------------------------------------------------------------------------

interface ListOption {
  id: string;
  name: string;
}
interface CampaignOption {
  id: string;
  name: string;
}

const RULE_TYPE_LABELS: Record<SegmentRule['type'], string> = {
  attribute: '联系人属性',
  subscription: '订阅状态',
  list: '列表成员',
  tag: '标签',
  createdAt: '注册时间',
  event: '行为',
  order: '下单',
};

const ATTRIBUTE_FIELD_LABELS: Record<string, string> = {
  country: '国家',
  state: '省份/州',
  city: '城市',
  language: '语言',
  gender: '性别',
};

const ATTRIBUTE_OPS: Array<{ value: 'eq' | 'neq' | 'in' | 'notIn'; label: string }> = [
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'in', label: '属于(多选)' },
  { value: 'notIn', label: '不属于(多选)' },
];

const SUBSCRIPTION_OPTIONS = [
  { value: 'subscribed', label: '已订阅' },
  { value: 'unsubscribed', label: '已退订' },
  { value: 'bounced', label: '弹回' },
  { value: 'complained', label: '投诉' },
  { value: 'pending', label: '待确认' },
] as const;

// `tag` is intentionally excluded from this picker until we ship a Tag
// management UI; backend evaluator still supports it for power-user JSON.
const ADDABLE_RULE_TYPES: Array<{ type: SegmentRule['type']; label: string }> = [
  { type: 'attribute', label: '联系人属性' },
  { type: 'subscription', label: '订阅状态' },
  { type: 'list', label: '列表成员' },
  { type: 'createdAt', label: '注册时间' },
  { type: 'event', label: '行为(打开/点击)' },
  { type: 'order', label: '下单(店铺订单)' },
];

function makeDefaultRule(type: SegmentRule['type']): SegmentRule {
  switch (type) {
    case 'attribute':
      return { type: 'attribute', field: 'country', op: 'eq', value: '' };
    case 'subscription':
      return { type: 'subscription', op: 'eq', value: 'subscribed' };
    case 'list':
      return { type: 'list', op: 'memberOf', values: [] };
    case 'tag':
      return { type: 'tag', op: 'hasAny', values: [] };
    case 'createdAt':
      return { type: 'createdAt', op: 'lastDays', days: 30 };
    case 'event':
      return { type: 'event', event: 'open', op: 'has', lastDays: 30 };
    case 'order':
      return { type: 'order', op: 'has' };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SegmentEditPage() {
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<SegmentRule[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Load existing segment for edit mode.
  const segQuery = useQuery<SegmentView>({
    queryKey: ['segment', id],
    queryFn: async () => (await api.get(`/api/segments/${id}`)).data,
    enabled: isEdit,
  });
  useEffect(() => {
    if (!segQuery.data) return;
    setName(segQuery.data.name);
    setDescription(segQuery.data.description ?? '');
    setRules(segQuery.data.definition.rules);
  }, [segQuery.data]);

  // Reference data for rule editors.
  const listsQuery = useQuery<ListOption[]>({
    queryKey: ['contact-lists', 'all'],
    queryFn: async () => (await api.get('/api/contact-lists?pageSize=1000')).data.items,
  });
  const campaignsQuery = useQuery<{ items: CampaignOption[] }>({
    queryKey: ['campaigns-for-segment'],
    queryFn: async () =>
      (await api.get('/api/campaigns', { params: { pageSize: 100 } })).data,
  });

  const definition: SegmentDefinition = useMemo(
    () => ({ v: 1, op: 'AND', rules }),
    [rules],
  );

  // ---- Persistence ----
  const saveMut = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), description: description.trim() || undefined, definition };
      if (isEdit) {
        return (await api.patch(`/api/segments/${id}`, body)).data;
      }
      return (await api.post('/api/segments', body)).data;
    },
    onSuccess: (data: SegmentView) => {
      qc.invalidateQueries({ queryKey: ['segments'] });
      qc.invalidateQueries({ queryKey: ['segment', data.id] });
      toast(isEdit ? '已保存' : '已创建分群', 'success');
      navigate('/segments');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const canSave =
    name.trim().length > 0 && rules.length > 0 && validateRules(rules) && !saveMut.isPending;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" asChild className="shrink-0">
            <Link to="/segments" aria-label="返回分群">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">{isEdit ? '编辑分群' : '创建分群'}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate('/segments')}>
            取消
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave}>
            {saveMut.isPending ? '保存中...' : isEdit ? '保存' : '创建'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: name + description + live preview in one card. Sticky so
            the preview stays visible as the user scrolls through a long
            rules list on the right. */}
        <div>
          <section className="sticky top-4 space-y-5 rounded-lg border bg-card p-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground">名称</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如:近 30 天活跃 US 用户"
                maxLength={120}
                className="mt-1"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                描述(可选)
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="向团队成员说明该分群的用途"
                rows={2}
                maxLength={500}
                className="mt-1"
              />
            </div>
            <div className="border-t pt-4">
              <PreviewPanel
                definition={definition}
                rulesValid={validateRules(rules)}
              />
            </div>
          </section>
        </div>

        {/* Right: rules editor (now the wider column). */}
        <div className="col-span-2">
          <section className="rounded-lg border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">规则</div>
                <div className="text-xs text-muted-foreground">
                  所有规则使用 <strong>AND</strong> 组合,联系人需同时满足全部条件
                </div>
              </div>
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddMenu((v) => !v)}
                >
                  <Plus className="mr-1 size-4" />
                  添加规则
                </Button>
                {showAddMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowAddMenu(false)}
                    />
                    <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-md border bg-popover shadow-lg">
                      {ADDABLE_RULE_TYPES.map((t) => (
                        <button
                          key={t.type}
                          type="button"
                          onClick={() => {
                            setRules((r) => [...r, makeDefaultRule(t.type)]);
                            setShowAddMenu(false);
                          }}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {rules.length === 0 && (
                <div className="rounded-md border border-dashed border-neutral-300 py-10 text-center text-sm text-muted-foreground">
                  点击右上角"添加规则"开始定义分群
                </div>
              )}
              {rules.map((rule, i) => (
                <RuleCard
                  key={i}
                  rule={rule}
                  onChange={(next) =>
                    setRules((rs) => rs.map((r, j) => (j === i ? next : r)))
                  }
                  onRemove={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                  lists={listsQuery.data ?? []}
                  campaigns={campaignsQuery.data?.items ?? []}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule card — switches on rule.type
// ---------------------------------------------------------------------------

function RuleCard({
  rule,
  onChange,
  onRemove,
  lists,
  campaigns,
}: {
  rule: SegmentRule;
  onChange: (r: SegmentRule) => void;
  onRemove: () => void;
  lists: ListOption[];
  campaigns: CampaignOption[];
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          {RULE_TYPE_LABELS[rule.type]}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
          aria-label="删除此规则"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {rule.type === 'attribute' && (
        <AttributeRuleEditor rule={rule} onChange={onChange} />
      )}
      {rule.type === 'subscription' && (
        <SubscriptionRuleEditor rule={rule} onChange={onChange} />
      )}
      {rule.type === 'list' && (
        <ListRuleEditor rule={rule} onChange={onChange} lists={lists} />
      )}
      {rule.type === 'tag' && (
        <div className="text-sm text-muted-foreground">
          标签规则当前仅支持通过 API 创建,UI 尚未提供。
        </div>
      )}
      {rule.type === 'createdAt' && (
        <CreatedAtRuleEditor rule={rule} onChange={onChange} />
      )}
      {rule.type === 'event' && (
        <EventRuleEditor rule={rule} onChange={onChange} campaigns={campaigns} />
      )}
      {rule.type === 'order' && <OrderRuleEditor rule={rule} onChange={onChange} />}
    </div>
  );
}

function AttributeRuleEditor({
  rule,
  onChange,
}: {
  rule: Extract<SegmentRule, { type: 'attribute' }>;
  onChange: (r: SegmentRule) => void;
}) {
  const isList = rule.op === 'in' || rule.op === 'notIn';
  return (
    <div className="grid grid-cols-3 gap-3">
      <FilterSelect
        value={rule.field}
        onChange={(v) =>
          onChange({ ...rule, field: v as typeof rule.field })
        }
        options={Object.entries(ATTRIBUTE_FIELD_LABELS).map(([value, label]) => ({
          value: value as typeof rule.field,
          label,
        }))}
      />
      <FilterSelect
        value={rule.op}
        onChange={(v) => {
          // When switching between scalar/list ops we have to reshape `value`
          // to stay zod-valid. Drop the current value rather than try to
          // guess — user can re-enter it.
          const nextOp = v as typeof rule.op;
          const nextIsList = nextOp === 'in' || nextOp === 'notIn';
          if (nextIsList) {
            onChange({ type: 'attribute', field: rule.field, op: nextOp, value: [] });
          } else {
            onChange({ type: 'attribute', field: rule.field, op: nextOp, value: '' });
          }
        }}
        options={ATTRIBUTE_OPS.map((o) => ({ value: o.value, label: o.label }))}
      />
      {isList ? (
        <Input
          value={Array.isArray(rule.value) ? rule.value.join(', ') : ''}
          onChange={(e) =>
            onChange({
              ...rule,
              op: rule.op,
              value: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            } as SegmentRule)
          }
          placeholder="多个值用逗号分隔,例如:US, CA, UK"
        />
      ) : (
        <Input
          value={typeof rule.value === 'string' ? rule.value : ''}
          onChange={(e) =>
            // The outer `isList` branch guarantees op ∈ {eq, neq} here, but
            // TS can't narrow the discriminated union through the spread, so
            // we rebuild the rule explicitly.
            onChange({
              type: 'attribute',
              field: rule.field,
              op: rule.op === 'in' || rule.op === 'notIn' ? 'eq' : rule.op,
              value: e.target.value,
            })
          }
          placeholder="输入值"
        />
      )}
    </div>
  );
}

function SubscriptionRuleEditor({
  rule,
  onChange,
}: {
  rule: Extract<SegmentRule, { type: 'subscription' }>;
  onChange: (r: SegmentRule) => void;
}) {
  return (
    <FilterSelect
      className="w-[180px]"
      value={rule.value}
      onChange={(v) => onChange({ ...rule, value: v as typeof rule.value })}
      options={SUBSCRIPTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
    />
  );
}

function ListRuleEditor({
  rule,
  onChange,
  lists,
}: {
  rule: Extract<SegmentRule, { type: 'list' }>;
  onChange: (r: SegmentRule) => void;
  lists: ListOption[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterSelect
        className="w-[180px]"
        value={rule.op}
        onChange={(v) => onChange({ ...rule, op: v as typeof rule.op })}
        options={[
          { value: 'memberOf', label: '属于以下列表' },
          { value: 'notMemberOf', label: '不属于以下列表' },
        ]}
      />
      <FilterMultiSelect
        className="min-w-[240px] flex-1"
        value={rule.values}
        onChange={(next) => onChange({ ...rule, values: next })}
        options={lists.map((l) => ({ value: l.id, label: l.name }))}
        placeholder="选择联系人列表"
        emptyHint="尚无任何联系人列表"
      />
    </div>
  );
}

function CreatedAtRuleEditor({
  rule,
  onChange,
}: {
  rule: Extract<SegmentRule, { type: 'createdAt' }>;
  onChange: (r: SegmentRule) => void;
}) {
  // Mapping rule.from/rule.to ↔ DateRangePicker's DateRange. The picker
  // emits non-null ranges with both bounds set; clearing it returns null
  // which we translate back into both bounds = undefined. zod still
  // requires at least one of the two, enforced by validateRules().
  const dateRange: DateRange | null =
    rule.op === 'between' && (rule.from || rule.to)
      ? { from: rule.from ?? '', to: rule.to ?? '' }
      : null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterSelect
        className="w-[200px]"
        value={rule.op}
        onChange={(v) => {
          if (v === 'lastDays') {
            onChange({ type: 'createdAt', op: 'lastDays', days: 30 });
          } else {
            onChange({ type: 'createdAt', op: 'between' });
          }
        }}
        options={[
          { value: 'lastDays', label: '最近 N 天内注册' },
          { value: 'between', label: '在指定日期范围内' },
        ]}
      />
      {rule.op === 'lastDays' ? (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={3650}
            value={rule.days}
            onChange={(e) => onChange({ ...rule, days: Number(e.target.value) || 1 })}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">天</span>
        </div>
      ) : (
        <DateRangePicker
          className="min-w-[280px]"
          value={dateRange}
          onChange={(v) =>
            onChange({
              type: 'createdAt',
              op: 'between',
              from: v?.from,
              to: v?.to,
            })
          }
          placeholder="开始日期 至 结束日期"
        />
      )}
    </div>
  );
}

function EventRuleEditor({
  rule,
  onChange,
  campaigns,
}: {
  rule: Extract<SegmentRule, { type: 'event' }>;
  onChange: (r: SegmentRule) => void;
  campaigns: CampaignOption[];
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-xs text-muted-foreground">行为</label>
        <FilterSelect
          className="mt-1"
          value={rule.event}
          onChange={(v) => onChange({ ...rule, event: v as typeof rule.event })}
          options={[
            { value: 'open', label: '打开邮件' },
            { value: 'click', label: '点击链接' },
          ]}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">操作</label>
        <FilterSelect
          className="mt-1"
          value={rule.op}
          onChange={(v) => onChange({ ...rule, op: v as typeof rule.op })}
          options={[
            { value: 'has', label: '有过' },
            { value: 'notHas', label: '没有过' },
          ]}
        />
      </div>
      <div className="col-span-2">
        <label className="text-xs text-muted-foreground">活动(留空 = 任何活动)</label>
        <FilterSelect
          className="mt-1"
          value={rule.campaignId ?? ''}
          onChange={(v) =>
            onChange({ ...rule, campaignId: v === '' ? undefined : v })
          }
          options={[
            { value: '', label: '— 任何活动 —' },
            ...campaigns.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">最近 N 天内</label>
        <div className="mt-1 flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={3650}
            value={rule.lastDays}
            onChange={(e) => onChange({ ...rule, lastDays: Number(e.target.value) || 1 })}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">天</span>
        </div>
      </div>
    </div>
  );
}

function OrderRuleEditor({
  rule,
  onChange,
}: {
  rule: Extract<SegmentRule, { type: 'order' }>;
  onChange: (r: SegmentRule) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterSelect
        className="w-[200px]"
        value={rule.op}
        onChange={(v) => onChange({ ...rule, op: v as typeof rule.op })}
        options={[
          { value: 'has', label: '有过付款订单' },
          { value: 'notHas', label: '没有付款订单' },
        ]}
      />
      <FilterSelect
        className="w-[160px]"
        value={rule.lastDays === undefined ? 'any' : 'lastDays'}
        onChange={(v) =>
          onChange(
            v === 'any'
              ? { type: 'order', op: rule.op }
              : { type: 'order', op: rule.op, lastDays: 30 },
          )
        }
        options={[
          { value: 'any', label: '任意时间' },
          { value: 'lastDays', label: '最近 N 天内' },
        ]}
      />
      {rule.lastDays !== undefined && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={3650}
            value={rule.lastDays}
            onChange={(e) =>
              onChange({ ...rule, lastDays: Number(e.target.value) || 1 })
            }
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">天</span>
        </div>
      )}
      <div className="w-full text-xs text-muted-foreground">
        基于已绑定店铺同步的订单(已支付/已发货)进行匹配
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview (debounced)
// ---------------------------------------------------------------------------

function PreviewPanel({
  definition,
  rulesValid,
}: {
  definition: SegmentDefinition;
  rulesValid: boolean;
}) {
  const [debounced, setDebounced] = useState<SegmentDefinition | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!rulesValid) {
      setDebounced(null);
      return;
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setDebounced(definition);
    }, 500);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [definition, rulesValid]);

  const preview = useQuery<SegmentPreviewResult>({
    queryKey: ['segment-preview', debounced],
    queryFn: async () =>
      (await api.post('/api/segments/preview', { definition: debounced })).data,
    enabled: debounced !== null,
  });

  // Card wrapper + sticky positioning are now provided by the parent card
  // on the left column — this component only renders the preview content.
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-blue-600" />
        实时预览
      </div>
      {!rulesValid && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          有规则尚未填写完整,完成后将自动预览。
        </div>
      )}
      {rulesValid && preview.isLoading && (
        <div className="text-sm text-muted-foreground">计算中...</div>
      )}
      {rulesValid && preview.isError && (
        <div className="text-sm text-destructive">{apiErrMessage(preview.error)}</div>
      )}
      {rulesValid && preview.data && (
        <>
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-2 text-2xl font-semibold">
              <Users className="size-5 text-muted-foreground" />
              {formatNumber(preview.data.count)}
            </div>
            <div className="pb-1 text-xs text-muted-foreground">位联系人匹配</div>
          </div>
          {preview.data.sample.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs text-muted-foreground">样本</div>
              <ul className="space-y-1 text-sm">
                {preview.data.sample.map((c) => (
                  <li key={c.id} className="truncate">
                    {c.email}
                    {(c.firstName || c.lastName) && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({[c.firstName, c.lastName].filter(Boolean).join(' ')})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation — keeps Save/preview disabled while rules are incomplete.
// Mirrors the zod schema's required fields without re-parsing on every keystroke.
// ---------------------------------------------------------------------------

function validateRules(rules: SegmentRule[]): boolean {
  if (rules.length === 0) return false;
  for (const r of rules) {
    if (!isRuleComplete(r)) return false;
  }
  return true;
}

function isRuleComplete(r: SegmentRule): boolean {
  switch (r.type) {
    case 'attribute':
      if (r.op === 'eq' || r.op === 'neq') {
        return typeof r.value === 'string' && r.value.trim().length > 0;
      }
      return Array.isArray(r.value) && r.value.length > 0;
    case 'subscription':
      return Boolean(r.value);
    case 'list':
    case 'tag':
      return r.values.length > 0;
    case 'createdAt':
      if (r.op === 'lastDays') return r.days > 0;
      return Boolean(r.from || r.to);
    case 'event':
      return r.lastDays > 0;
    case 'order':
      return r.lastDays === undefined || r.lastDays > 0;
  }
}
