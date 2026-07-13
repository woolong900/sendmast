import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code as CodeIcon,
  HelpCircle,
  LayoutTemplate,
  Monitor,
  Search,
  Send,
  X,
} from 'lucide-react';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  EmailEditorProvider,
  EmailEditor,
  type IEmailTemplate,
} from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import {
  AdvancedType,
  BasicType,
  BlockManager,
  JsonToMjml,
  type IPage,
} from 'easy-email-core';
// Raw block ships only as a basic type (no AdvancedType.RAW); we still want
// it in the palette so users can drop in custom HTML / MJML snippets.
import mjml2html from 'mjml-browser';
import 'easy-email-editor/lib/style.css';
import 'easy-email-extensions/lib/style.css';
import '@arco-design/web-react/dist/css/arco.css';
// Override easy-email-core's default vercel-demo asset URLs (now 404).
// MUST stay below the easy-email-* imports above so this side-effect runs
// AFTER core's own `ImageManager.add(defaultImagesMap)` initializer.
import '@/lib/easy-email-image-overrides';
import '@/lib/easy-email-raw-block-fix';
// Raw-HTML editor for `editorMode === 'html'` campaigns. CodeMirror 6 (via
// the @uiw wrapper) — separate codepath from easy-email's CodeMirror 5,
// they coexist because they ship under different package names.
import CodeMirror from '@uiw/react-codemirror';
import { html as cmHtmlLang } from '@codemirror/lang-html';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api, apiErrMessage } from '@/lib/api';
import { easyEmailZhCN } from '@/lib/easy-email-locale';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { formatNumber } from '@/lib/utils';
import { VariablesHelper } from '@/components/VariablesHelper';
import { FullscreenEmailEditor } from '@/components/FullscreenEmailEditor';
import { type SegmentView, type SenderDomainView } from '@sendmast/shared';
import { useQuota } from '@/hooks/useQuota';

interface ContactList {
  id: string;
  name: string;
  contactsCount: number;
}
interface Template {
  id: string;
  name: string;
  scope: 'system' | 'user';
}
interface CampaignDetail {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  fromName: string;
  fromEmail: string;
  /** Full sender roster (position-ordered). Absent on pre-feature responses. */
  senders?: Array<{ fromEmail: string; fromName: string; position: number }>;
  replyTo: string | null;
  templateId: string | null;
  html: string | null;
  mjml: string | null;
  designJson: IEmailTemplate | null;
  /** Picked in step 0; tells step 2 which editor to render. Optional in the
   *  type so old API responses (pre-feature) don't break the prefill effect —
   *  we fall back to a designJson/html heuristic if it's missing. */
  editorMode?: 'visual' | 'html';
  status: string;
  scheduledAt: string | null;
  utmEnabled: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  trackClicks: boolean;
  lists: Array<{ listId: string; list: { id: string; name: string } }>;
  segments?: Array<{ segmentId: string; segment: { id: string; name: string } }>;
}

type EditorMode = 'visual' | 'html';

// Starter snippet shown in the CodeMirror editor when a user first picks the
// HTML mode and no body has been saved yet. Intentionally barebones — we
// don't want to push aesthetic decisions on hand-coded campaigns; just give
// them a valid scaffold that works in Outlook/Gmail.
const HTML_STARTER = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{subject}}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">你好,{{first_name}}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
                  在这里粘贴或编写你的 HTML 邮件正文。支持 Mustache 风格的变量,例如
                  <code>{{first_name}}</code> 与 <code>{{email}}</code>。
                </p>
                <p style="margin:24px 0 0;">
                  <a href="https://example.com" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">立即查看</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const SUBJECT_MAX = 150;
const PREHEADER_MAX = 100;

// Easy Email left-panel block palette. Mirrors the shipped "Standard" recipe
// but in 中文; kept in a single place so TemplateEditorPage and this wizard
// stay visually consistent (their categories are intentionally identical).
const blockCategories = [
  {
    label: '基础组件',
    active: true,
    blocks: [
      { type: AdvancedType.TEXT },
      { type: AdvancedType.IMAGE },
      { type: AdvancedType.BUTTON },
      { type: AdvancedType.SOCIAL },
      { type: AdvancedType.DIVIDER },
      { type: AdvancedType.NAVBAR },
      { type: AdvancedType.CAROUSEL },
      { type: AdvancedType.ACCORDION },
      // WRAPPER / SECTION / COLUMN / GROUP are MJML structural primitives —
      // we omit them from the palette because users almost always want to
      // start from a content block or a column-layout preset. They remain
      // registered in BlockManager so the canvas can still render existing
      // designs and the "布局" presets below (which insert SECTION + COLUMNs
      // under the hood) keep working.
      // Raw block — escape-hatch for arbitrary HTML / MJML. Two shipped
      // defaults are bad for UX: (1) `<% if (user) { %>` is an EJS marker
      // that looks like a syntax error, (2) a bare <p> renders as a single
      // line of body text, so the dropped block is nearly invisible on the
      // canvas and easy to miss-click — leaving focusBlock null and the
      // right-side AttributePanel blank. Use a styled placeholder div so
      // the block is obviously selectable; users replace it on first edit.
      {
        type: BasicType.RAW,
        payload: {
          data: {
            value: {
              content:
                '<div style="padding:24px;border:2px dashed #d1d5db;background:#f9fafb;color:#6b7280;text-align:center;font-family:sans-serif;font-size:14px;line-height:1.6;">自定义代码块 — 选中后在右侧粘贴 HTML<br/><span style="font-size:12px;">(若只需文字段落，请改用「文本」块)</span></div>',
            },
          },
        },
      },
      // Footer-style unsubscribe text. `{{unsubscribe_url}}` is one of our
      // system tags (see packages/shared/src/schemas/system-tags.ts) — at
      // send time worker-sender substitutes it with the recipient-specific
      // /t/u/<token> URL. Users can double-click to edit the wording.
      {
        title: '底部退订',
        type: AdvancedType.TEXT,
        payload: {
          attributes: {
            color: '#9ca3af',
            'font-size': '12px',
            'line-height': '1.6',
            align: 'center',
            padding: '24px 25px',
          },
          data: {
            value: {
              content:
                'You received this email because you subscribed to our updates.<br/>Don\'t want to receive these anymore? <a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>',
            },
          },
        },
      },
    ],
  },
  {
    label: '布局',
    displayType: 'column' as const,
    blocks: [
      { title: '2 列等分', payload: [['50%', '50%']] },
      { title: '2 列 1:2', payload: [['33%', '67%']] },
      { title: '2 列 2:1', payload: [['67%', '33%']] },
      { title: '3 列等分', payload: [['33%', '33%', '33%']] },
      { title: '4 列等分', payload: [['25%', '25%', '25%', '25%']] },
    ],
  },
];

export function CampaignWizardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id: editingId } = useParams<{ id?: string }>();
  const isEdit = !!editingId;
  const [step, setStep] = useState(0);
  const isMobileViewport = useIsMobileViewport();

  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  // fromName is derived from the picked sender username's displayName.
  // Removed as a standalone input — see derivedFromName below.
  // Multi-sender: the campaign can rotate through several from-addresses.
  // fromEmails[0] is the primary (mirrored onto Campaign.fromEmail and used
  // for previews); the rest are extra rotation slots.
  const [fromEmails, setFromEmails] = useState<string[]>([]);
  const fromEmail = fromEmails[0] ?? '';
  const [replyTo, setReplyTo] = useState('');
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [blankSelected, setBlankSelected] = useState(false);
  const [editorHtml, setEditorHtml] = useState<string | null>(null);
  const [editorMjml, setEditorMjml] = useState<string | null>(null);
  const [editorDesign, setEditorDesign] = useState<IEmailTemplate | null>(null);
  // Picked in the step-0 "邮件设计方式" card. 'visual' (default) routes
  // step 2 into Easy Email; 'html' routes it into a CodeMirror raw-HTML
  // editor and skips step 1 (template picker is irrelevant for hand-coded
  // campaigns). Switching modes after content exists prompts a confirm
  // dialog and clears all body fields — see `requestEditorModeChange`.
  const [editorMode, setEditorMode] = useState<EditorMode>('visual');
  // Holds the requested target mode while the confirm dialog is open. Null
  // means "no switch in flight". Distinct from `editorMode` so the user
  // can cancel without losing the visual feedback of which card is active.
  const [editorModeSwitchPending, setEditorModeSwitchPending] = useState<EditorMode | null>(null);
  // Resolved Easy Email template handed to <EmailEditorProvider data> on
  // step 2 entry. null = still loading / not yet resolved.
  const [step2Initial, setStep2Initial] = useState<IEmailTemplate | null>(null);
  // Bumped on every explicit template pick so the resolve effect always
  // re-runs — even when the pick leaves editorDesign/selectedTemplateId
  // unchanged (e.g. re-selecting "blank" only flips blankSelected). Without
  // this the effect wouldn't fire and step2Initial would stay null, stranding
  // the editor on its "加载编辑器…" loading state.
  const [pickNonce, setPickNonce] = useState(0);
  // True when the campaign was authored with the legacy react-email-editor
  // (its design_json was wiped in the easy-email migration, but `html`
  // remains so existing sends keep working). Surfaces a banner in step 2.
  const [isLegacyCampaign, setIsLegacyCampaign] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [savedEdit, setSavedEdit] = useState(false);

  const [utmCustomized, setUtmCustomized] = useState(false);
  const [utmSource, setUtmSource] = useState('');
  const [utmMedium, setUtmMedium] = useState('');
  const [utmCampaign, setUtmCampaign] = useState('');
  const [trackClicks, setTrackClicks] = useState(true);

  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduleAt, setScheduleAt] = useState('');

  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateReplacePending, setTemplateReplacePending] = useState<
    { kind: 'template'; id: string } | { kind: 'blank' } | null
  >(null);

  const prefilled = useRef(false);

  const detail = useQuery<CampaignDetail>({
    queryKey: ['campaigns', editingId],
    queryFn: async () => (await api.get(`/api/campaigns/${editingId}`)).data,
    enabled: isEdit,
  });

  // One-shot prefill from existing campaign (avoid clobbering user edits).
  // Wait for a settled fetch (not isFetching) before prefilling — otherwise
  // React Query hands us stale cached data on the first render and we'd lock
  // that into state before the background refetch finishes.
  useEffect(() => {
    if (!detail.data || detail.isFetching || prefilled.current) return;
    const d = detail.data;
    setName(d.name);
    setSubject(d.subject);
    setPreheader(d.preheader ?? '');
    setFromEmails(
      d.senders && d.senders.length > 0
        ? d.senders.map((s) => s.fromEmail)
        : d.fromEmail
          ? [d.fromEmail]
          : [],
    );
    setReplyTo(d.replyTo ?? '');
    setSelectedListIds(d.lists.map((l) => l.listId));
    // segments may be undefined on older API responses; default to []
    // rather than throwing on optional chaining.
    setSelectedSegmentIds((d.segments ?? []).map((s: { segmentId: string }) => s.segmentId));
    if (d.templateId) {
      setSelectedTemplateId(d.templateId);
    } else if (d.html) {
      setBlankSelected(true);
    }
    if (d.html) setEditorHtml(d.html);
    if (d.mjml) setEditorMjml(d.mjml);
    if (d.designJson) {
      setEditorDesign(d.designJson);
    } else if (d.html && d.editorMode !== 'html') {
      // html-only after the easy-email migration → legacy editor content.
      // Suppressed when editorMode='html' because that's a deliberate raw-HTML
      // campaign, not a legacy import.
      setIsLegacyCampaign(true);
    }
    // Editor-mode prefill: trust the column when present, otherwise infer
    // from the body shape (designJson missing + html present = hand-coded).
    if (d.editorMode === 'html' || d.editorMode === 'visual') {
      setEditorMode(d.editorMode);
    } else if (!d.designJson && d.html) {
      setEditorMode('html');
    }
    if (d.utmSource || d.utmMedium || d.utmCampaign) {
      setUtmCustomized(true);
      setUtmSource(d.utmSource ?? '');
      setUtmMedium(d.utmMedium ?? '');
      setUtmCampaign(d.utmCampaign ?? '');
    }
    setTrackClicks(d.trackClicks);
    prefilled.current = true;
  }, [detail.data, detail.isFetching]);

  const lists = useQuery<ContactList[]>({
    queryKey: ['contact-lists', 'all'],
    queryFn: async () => (await api.get('/api/contact-lists?pageSize=1000')).data.items,
  });
  const segments = useQuery<SegmentView[]>({
    queryKey: ['segments'],
    queryFn: async () => (await api.get('/api/segments')).data,
  });
  const domains = useQuery<SenderDomainView[]>({
    queryKey: ['sender-domains'],
    queryFn: async () => (await api.get('/api/sender-domains')).data,
  });
  const templates = useQuery<Template[]>({
    queryKey: ['templates'],
    queryFn: async () => (await api.get('/api/templates')).data,
  });
  // Shared quota query (TopBar / DashboardPage / QuotaPage use the same hook +
  // cache key) so the wizard's send-button gate re-enables within ~30s of a
  // top-up without a page reload.
  const quota = useQuota();
  const quotaRemaining = quota.data?.remaining ?? 0;
  const quotaExhausted = quota.data !== undefined && quotaRemaining <= 0;

  const verifiedDomains = useMemo(
    () =>
      domains.data?.filter(
        (d) => d.status === 'verified' && d.emailChannel?.allowMarketing !== false,
      ) ?? [],
    [domains.data],
  );

  // Flatten verified domains × their sender usernames into the actual list
  // of from-addresses the selected provider will accept. A domain with no sender username
  // contributes no options (the user is pointed to the domain's wizard
  // step 3 to add one).
  // Show the email channel label next to each sender only when the tenant spans
  // more than one email channel (cross-channel sending), so single-channel tenants stay
  // uncluttered.
  const multiChannel = useMemo(
    () => new Set(verifiedDomains.map((d) => d.emailChannel?.id ?? d.emailChannelId)).size > 1,
    [verifiedDomains],
  );
  const senderOptions = useMemo(
    () =>
      verifiedDomains.flatMap((d) =>
        d.senderUsernames.map((u) => ({
          value: u.fullAddress,
          label: u.displayName ? `${u.displayName} <${u.fullAddress}>` : u.fullAddress,
          displayName: u.displayName,
          username: u.username,
          channelName: multiChannel ? d.emailChannel?.name ?? null : null,
        })),
      ),
    [verifiedDomains, multiChannel],
  );

  // Resolve the sender username record matching the chosen address so we can
  // derive a from-name from its configured displayName. Falls back to the
  // local-part if the address isn't (yet) in the verified options list — this
  // keeps the preview and the API payload non-empty during edit-mode prefill
  // before the domains query has settled.
  const nameForEmail = useCallback(
    (email: string) => {
      if (!email) return '';
      const opt = senderOptions.find((o) => o.value === email);
      const name = opt?.displayName?.trim() || opt?.username || email.split('@')[0] || '';
      return name.trim();
    },
    [senderOptions],
  );

  const derivedFromName = useMemo(
    () => nameForEmail(fromEmail),
    [fromEmail, nameForEmail],
  );

  // Full roster sent to the API: every selected address paired with its
  // derived from-name, in selection order (index 0 = primary).
  const senders = useMemo(
    () => fromEmails.map((e) => ({ fromEmail: e, fromName: nameForEmail(e) })),
    [fromEmails, nameForEmail],
  );

  const domainsMissingUsernames = useMemo(
    () => verifiedDomains.filter((d) => d.senderUsernames.length === 0),
    [verifiedDomains],
  );

  const totalRecipients = useMemo(() => {
    const listSum = (lists.data ?? [])
      .filter((l) => selectedListIds.includes(l.id))
      .reduce((sum, l) => sum + l.contactsCount, 0);
    // Segment counts can be null (not yet refreshed); treat as 0 for the
    // estimate. The helper text below clarifies this is approximate.
    const segSum = (segments.data ?? [])
      .filter((s) => selectedSegmentIds.includes(s.id))
      .reduce((sum, s) => sum + (s.cachedCount ?? 0), 0);
    return listSum + segSum;
  }, [lists.data, segments.data, selectedListIds, selectedSegmentIds]);

  // Resolve the Easy Email IEmailTemplate to feed <EmailEditorProvider data>
  // on editor-step entry. Priority: user-edited design > picked template's designJson
  // > empty. Cleared on step exit so re-entry re-resolves fresh — important
  // when the user changes selectedTemplateId between visits.
  useEffect(() => {
    if (step !== 1 || editorMode !== 'visual') {
      setStep2Initial(null);
      return;
    }
    let cancelled = false;
    const resolve = async (): Promise<IEmailTemplate> => {
      if (editorDesign) return editorDesign;
      if (selectedTemplateId) {
        const r = await api.get(`/api/templates/${selectedTemplateId}`);
        if (r.data?.designJson) return r.data.designJson as IEmailTemplate;
      }
      const page = BlockManager.getBlockByType(BasicType.PAGE)!.create({}) as IPage;
      return { content: page, subject: '', subTitle: '' };
    };
    resolve().then((d) => {
      if (!cancelled) setStep2Initial(d);
    });
    return () => {
      cancelled = true;
    };
  }, [step, editorDesign, selectedTemplateId, pickNonce]);

  const payload = () => ({
    name,
    subject,
    // Always send the field (even when empty) so clearing it actually
    // persists. `|| undefined` here used to drop the empty string, which made
    // PATCH leave the old preheader untouched — clearing it in the UI looked
    // saved but reverted on reopen.
    preheader: preheader.trim(),
    fromName: derivedFromName,
    fromEmail,
    senders: senders.length > 0 ? senders : undefined,
    replyTo: replyTo || undefined,
    templateId: selectedTemplateId ?? undefined,
    html: editorHtml ?? undefined,
    mjml: editorMjml ?? undefined,
    designJson: editorDesign ?? undefined,
    editorMode,
    listIds: selectedListIds,
    segmentIds: selectedSegmentIds,
    utmEnabled: true,
    utmSource: utmCustomized && utmSource ? utmSource : undefined,
    utmMedium: utmCustomized && utmMedium ? utmMedium : undefined,
    utmCampaign: utmCustomized && utmCampaign ? utmCampaign : undefined,
    trackClicks,
  });

  const saveDraftMut = useMutation({
    // Accepts an optional body override so callers (e.g. the editor's
    // "save & exit" flow) can pass freshly-exported html/mjml/designJson
    // without waiting for state to flush.
    mutationFn: (override?: { html?: string; mjml?: string; designJson?: IEmailTemplate }) => {
      const body = { ...payload(), ...override };
      const existingId = isEdit ? editingId : createdId;
      return existingId
        ? api.patch(`/api/campaigns/${existingId}`, body)
        : api.post('/api/campaigns', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      navigate('/campaigns');
    },
  });

  // Persists the editor's content as a draft when advancing from step 2 to
  // step 3. Without this, the user could exit later (from preview ↩ editor)
  // believing they had saved, but only React state held the changes.
  const saveContentMut = useMutation({
    // mjml / designJson are optional — visual mode passes both, html mode
    // passes neither (their state vars are null in that branch and payload()
    // already strips them via `?? undefined`).
    mutationFn: (override: {
      html: string;
      mjml?: string;
      designJson?: IEmailTemplate;
    }) => {
      // No client-side thumbnail here: the campaign list renders previews from
      // the live HTML in an iframe, so a baked PNG is unnecessary — and the old
      // html-to-image capture silently failed on emails with remote images
      // (CORS-tainted canvas), leaving stale/placeholder thumbnails.
      const body = { ...payload(), ...override };
      const existingId = isEdit ? editingId : createdId;
      return existingId
        ? api.patch(`/api/campaigns/${existingId}`, body)
        : api.post('/api/campaigns', body);
    },
    onSuccess: (r) => {
      if (isEdit) setSavedEdit(true);
      else if (!createdId) setCreatedId(r.data.id);
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
      // Refresh any currently mounted hover preview after an edit.
      void qc.invalidateQueries({ queryKey: ['campaign-html'] });
    },
  });

  const sendableId = isEdit ? (savedEdit ? editingId! : null) : createdId;

  // Finalize send: persist scheduledAt (if scheduling) then send. Wrapping
  // both into one mutation gives a single isPending/isError surface for the UI.
  const finalizeMut = useMutation({
    mutationFn: async () => {
      if (!sendableId) throw new Error('未保存');
      if (sendMode === 'schedule') {
        if (!scheduleAt) throw new Error('请选择发送时间');
        await api.patch(`/api/campaigns/${sendableId}`, {
          scheduledAt: new Date(scheduleAt).toISOString(),
        });
      }
      return api.post(`/api/campaigns/${sendableId}/send`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      navigate('/campaigns');
    },
  });

  function next() {
    if (step === 0 && !canNextFromStep0()) return;
    setStep((s) => Math.min(2, s + 1));
  }

  /**
   * Step-0 mode-card handler. If switching to a different editor and there
   * is any persisted body state (html / mjml / designJson / picked template),
   * we open a confirm dialog because committing the switch will null those
   * fields out — see `confirmEditorModeChange`. Picking the same mode is a
   * no-op so re-clicking the active card doesn't blow away your work.
   */
  function requestEditorModeChange(target: EditorMode) {
    if (editorMode === target) return;
    const hasBody = !!(editorHtml || editorMjml || editorDesign || selectedTemplateId);
    if (hasBody) {
      setEditorModeSwitchPending(target);
      return;
    }
    setEditorMode(target);
  }

  function confirmEditorModeChange() {
    const target = editorModeSwitchPending;
    if (!target) return;
    setEditorHtml(null);
    setEditorMjml(null);
    setEditorDesign(null);
    setSelectedTemplateId(null);
    setBlankSelected(false);
    setIsLegacyCampaign(false);
    setEditorMode(target);
    setEditorModeSwitchPending(null);
  }

  function canNextFromStep0() {
    return Boolean(
      name.trim() &&
        subject.trim() &&
        fromEmail.trim() &&
        // Audience must be non-empty — either a list, a segment, or both.
        (selectedListIds.length > 0 || selectedSegmentIds.length > 0),
    );
  }

  function needsTemplateReplaceConfirm(isEditorDirty?: boolean): boolean {
    return !!(
      isEditorDirty ||
      editorHtml ||
      editorMjml ||
      editorDesign ||
      selectedTemplateId ||
      blankSelected
    );
  }

  function commitTemplatePick(pick: { kind: 'template'; id: string } | { kind: 'blank' }) {
    if (pick.kind === 'blank') {
      pickBlank();
    } else {
      pickTemplate(pick.id);
    }
    setEditorDesign(null);
    setStep2Initial(null);
    setPickNonce((n) => n + 1);
    setTemplatePickerOpen(false);
    setTemplateReplacePending(null);
  }

  function requestTemplatePick(
    pick: { kind: 'template'; id: string } | { kind: 'blank' },
    isEditorDirty?: boolean,
  ) {
    if (pick.kind === 'template' && pick.id === selectedTemplateId) {
      setTemplatePickerOpen(false);
      return;
    }
    if (pick.kind === 'blank' && blankSelected && !selectedTemplateId && !editorDesign) {
      setTemplatePickerOpen(false);
      return;
    }
    if (needsTemplateReplaceConfirm(isEditorDirty)) {
      setTemplateReplacePending(pick);
      return;
    }
    commitTemplatePick(pick);
  }

  // Compile an Easy Email IEmailTemplate to MJML + HTML for persistence.
  // Both the "save & next" and "save & exit" flows go through this so the
  // backend always receives mjml + html together.
  function compile(values: IEmailTemplate): { mjml: string; html: string } {
    const mjml = JsonToMjml({
      data: values.content,
      mode: 'production',
      context: values.content,
    });
    const html = mjml2html(mjml).html;
    return { mjml, html };
  }

  function pickTemplate(tplId: string) {
    if (selectedTemplateId !== tplId) {
      setEditorHtml(null);
      setEditorMjml(null);
      setEditorDesign(null);
      setIsLegacyCampaign(false);
    }
    setSelectedTemplateId(tplId);
    setBlankSelected(false);
  }

  function pickBlank() {
    if (selectedTemplateId !== null || !blankSelected) {
      setEditorHtml(null);
      setEditorMjml(null);
      setEditorDesign(null);
      setIsLegacyCampaign(false);
    }
    setSelectedTemplateId(null);
    setBlankSelected(true);
  }

  if (isEdit && detail.isLoading) {
    return <PageSkeleton withBack />;
  }

  if (step === 0) {
    return (
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" asChild className="shrink-0">
            <Link to="/campaigns" aria-label="返回列表">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Email 营销</h1>
        </div>

        <Card>
          <CardContent className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
            <div className="space-y-5">
              <div>
                <div className="text-sm font-semibold text-foreground">活动名称</div>
                <Input
                  className="mt-2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="活动名称"
                />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">收件人</div>
                <div className="mt-2">
                  <RecipientSelect
                    lists={lists.data ?? []}
                    segments={segments.data ?? []}
                    selectedLists={selectedListIds}
                    selectedSegments={selectedSegmentIds}
                    onChangeLists={setSelectedListIds}
                    onChangeSegments={setSelectedSegmentIds}
                  />
                </div>
                {(selectedListIds.length > 0 || selectedSegmentIds.length > 0) && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    已选 {selectedListIds.length} 个列表
                    {selectedSegmentIds.length > 0
                      ? ` + ${selectedSegmentIds.length} 个分群`
                      : ''}
                    ,预计 {formatNumber(totalRecipients)} 收件人(去重和订阅状态由后端处理)
                  </div>
                )}
              </div>
            </div>
            <div aria-hidden />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-foreground">主题</div>
                  <VariablesHelper />
                </div>
                <div className="relative mt-2">
                  <textarea
                    value={subject}
                    maxLength={SUBJECT_MAX}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="客户收到的邮件主题，建议在150个字内（支持变量，如 {{first_name}}）"
                    className="block min-h-[80px] w-full resize-none rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="pointer-events-none absolute bottom-2 right-3 text-xs text-muted-foreground">
                    {subject.length}/{SUBJECT_MAX}
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-foreground">
                    内文预览{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      （选填）
                    </span>
                  </div>
                  <VariablesHelper />
                </div>
                <div className="relative mt-2">
                  <textarea
                    value={preheader}
                    maxLength={PREHEADER_MAX}
                    onChange={(e) => setPreheader(e.target.value)}
                    placeholder="客户收到的内文预览，建议在100个字内（支持变量）"
                    className="block min-h-[80px] w-full resize-none rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="pointer-events-none absolute bottom-2 right-3 text-xs text-muted-foreground">
                    {preheader.length}/{PREHEADER_MAX}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-3 text-sm font-semibold text-foreground">寄件人</div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <div className="flex h-5 items-center justify-between">
                      <Label className="text-xs text-muted-foreground">
                        选择寄件地址（可多选，发送时轮流使用）
                      </Label>
                      <Link
                        to="/settings/domains/new"
                        className="text-xs text-primary hover:underline"
                      >
                        新增
                      </Link>
                    </div>
                    {verifiedDomains.length === 0 ? (
                      <div className="text-xs text-amber-600">
                        没有已验证的发件域名，请先{' '}
                        <Link to="/settings/domains" className="text-primary underline">
                          添加并验证一个域名
                        </Link>
                      </div>
                    ) : senderOptions.length === 0 ? (
                      <div className="text-xs text-amber-600">
                        已验证域名还没有发件人邮箱,请先{' '}
                        <Link
                          to={`/settings/domains/new?id=${domainsMissingUsernames[0].id}`}
                          className="text-primary underline"
                        >
                          为 {domainsMissingUsernames[0].domain} 添加发件人
                        </Link>
                      </div>
                    ) : (
                      <SenderEmailSelect
                        values={fromEmails}
                        onChange={setFromEmails}
                        options={senderOptions}
                      />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex h-5 items-center">
                      <Label className="text-xs text-muted-foreground">
                        接收回复的邮箱{' '}
                        <span className="text-muted-foreground">（选填）</span>
                      </Label>
                    </div>
                    <Input
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      placeholder="接收回复的邮箱"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-3 text-sm font-semibold text-foreground">收件箱预览</div>
              <InboxPreview fromName={derivedFromName} subject={subject} preheader={preheader} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-6">
            <div className="text-sm font-semibold text-foreground">
              高级设置{' '}
              <span className="text-xs font-normal text-muted-foreground">（选填）</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">UTM数据追踪</span>
              <HelpCircle className="size-3.5 text-muted-foreground" />
              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                默认启用
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              未自定义参数时，则默认拼接
              <br />
              {'utm_source: sendmast、utm_medium: email、utm_campaign: {{campaign_id}}'}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={utmCustomized}
                onChange={(e) => {
                  const on = e.target.checked;
                  setUtmCustomized(on);
                  // Pre-fill utm_campaign with the campaign-id variable so the
                  // custom path defaults to the same behaviour as the auto path.
                  if (on && !utmCampaign) setUtmCampaign('{{campaign_id}}');
                }}
              />
              数据追踪参数自定义
            </label>
            {utmCustomized && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">utm_source</Label>
                    <VariablesHelper />
                  </div>
                  <Input
                    value={utmSource}
                    onChange={(e) => setUtmSource(e.target.value)}
                    placeholder="sendmast"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">utm_medium</Label>
                    <VariablesHelper />
                  </div>
                  <Input
                    value={utmMedium}
                    onChange={(e) => setUtmMedium(e.target.value)}
                    placeholder="email"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">utm_campaign</Label>
                    <VariablesHelper />
                  </div>
                  <Input
                    value={utmCampaign}
                    onChange={(e) => setUtmCampaign(e.target.value)}
                    placeholder="{{campaign_id}}"
                  />
                </div>
              </div>
            )}

            <div className="border-t pt-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">链接点击追踪</span>
                <HelpCircle className="size-3.5 text-muted-foreground" />
                <span
                  className={
                    'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ring-1 ' +
                    (trackClicks
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                      : 'bg-muted text-muted-foreground ring-border')
                  }
                >
                  <span
                    className={
                      'size-1.5 rounded-full ' +
                      (trackClicks ? 'bg-emerald-500' : 'bg-muted-foreground/60')
                    }
                  />
                  {trackClicks ? '已开启' : '已关闭'}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                开启后，邮件中的链接会被改写为跳转链接以统计点击；关闭后链接直达原落地页，
                不再统计点击数据（打开统计、UTM 参数追加不受影响）。
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={trackClicks}
                  onChange={(e) => setTrackClicks(e.target.checked)}
                />
                追踪链接点击
              </label>
            </div>
          </CardContent>
        </Card>

        {/* 邮件设计方式 — last decision before 下一步; selecting 'html'
            also skips the step-1 template picker (templates are visual-only). */}
        <Card>
          <CardContent className="space-y-4 p-6">
            <div>
              <div className="text-sm font-semibold text-foreground">
                邮件设计方式 <span className="text-destructive">*</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                选择「拖放编辑器」可视化搭建邮件，或选择「HTML」直接粘贴/编写代码。
                拖放模式下可在编辑器内随时选择模板。
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <EditorModeCard
                active={editorMode === 'visual'}
                onClick={() => requestEditorModeChange('visual')}
                icon={<LayoutTemplate className="size-6" />}
                title="拖放编辑器"
                description="使用可视化拖放编辑器创建邮件"
              />
              <EditorModeCard
                active={editorMode === 'html'}
                onClick={() => requestEditorModeChange('html')}
                icon={<CodeIcon className="size-6" />}
                title="HTML"
                description="直接编写或粘贴 HTML 代码以获得完全控制"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            onClick={() => saveDraftMut.mutate(undefined)}
            disabled={!name.trim() || saveDraftMut.isPending}
          >
            {saveDraftMut.isPending ? '保存中...' : '保存草稿'}
          </Button>
          <Button onClick={next} disabled={!canNextFromStep0()}>
            下一步
            <ArrowRight className="ml-1 size-4" />
          </Button>
        </div>
        {saveDraftMut.isError && (
          <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {apiErrMessage(saveDraftMut.error)}
          </div>
        )}
        <EditorModeSwitchDialog
          target={editorModeSwitchPending}
          onCancel={() => setEditorModeSwitchPending(null)}
          onConfirm={confirmEditorModeChange}
        />
      </div>
    );
  }

  // Step 1 — full-screen editor (Easy Email visual / CodeMirror HTML).
  if (step === 1) {
    // Mobile blocker — both editors (Easy Email visual + side-by-side HTML)
    // are desktop-only flows. Easy Email mounts a fixed 100vh canvas with
    // a left sidebar of block categories; the HTML editor splits the screen
    // horizontally into code + preview. Both are unusable below md and the
    // upstream libraries have no mobile mode. Better to redirect than to
    // half-render something broken — basic info / recipients / send (steps
    // 0 + 3) still work fine on phones, so the user can build everything
    // around the body and finish editing on a desktop.
    if (isMobileViewport) {
      return <MobileEditorBlocker mode={editorMode} onBack={() => setStep(0)} />;
    }
    // HTML mode: doesn't need step2Initial (that's the Easy Email seed).
    if (editorMode === 'html') {
      return (
        <HtmlEditorStep
          initialHtml={editorHtml ?? HTML_STARTER}
          saving={saveContentMut.isPending}
          saveError={saveContentMut.isError ? apiErrMessage(saveContentMut.error) : null}
          onExit={() => setStep(0)}
          onSave={(html, intent) => {
            // Visual-mode body fields aren't applicable in HTML mode — we
            // null them so the API call doesn't echo stale designJson back
            // to the server (the backend's resolveBody also nulls mjml when
            // html is provided, but designJson is opt-in and we want it gone).
            setEditorHtml(html);
            setEditorMjml(null);
            setEditorDesign(null);
            setIsLegacyCampaign(false);
            saveContentMut.mutate(
              { html },
              {
                onSuccess: () => {
                  if (intent === 'advance') setStep(2);
                  else setStep(0);
                },
              },
            );
          }}
        />
      );
    }

    if (!step2Initial) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background text-sm text-muted-foreground">
          加载编辑器…
        </div>
      );
    }

    const exitToBasic = () => {
      setExitConfirmOpen(false);
      setStep(0);
    };

    return (
      <ConfigProvider locale={zhCN}>
        <EmailEditorProvider
          // Re-mount on template/edit-state change so final-form's initialValues
          // refresh; otherwise picking a different template after entering
          // step 2 wouldn't update the editor.
          key={selectedTemplateId ?? (editorDesign ? 'edited' : 'blank')}
          data={step2Initial}
          // Fullscreen overlay: viewport height minus our own 49px header bar
          // (no Layout topbar to subtract since `fixed inset-0` escapes Layout).
          // Legacy banner adds ~32px when shown; the editor's own scroll handles
          // the slight overflow gracefully — same behaviour as pre-fullscreen.
          height="calc(100vh - 49px)"
          autoComplete
          dashed={false}
          locale={easyEmailZhCN}
          onUploadImage={uploadEditorImage}
          onSubmit={() => {
            // We drive saves manually via helper.getState(); onSubmit is unused
            // but required by the provider's prop contract.
          }}
        >
          {(_props, helper) => {
            const persist = (intent: 'advance' | 'exit') => {
              const values = helper.getState().values as IEmailTemplate;
              const { mjml, html } = compile(values);
              setEditorHtml(html);
              setEditorMjml(mjml);
              setEditorDesign(values);
              setIsLegacyCampaign(false);
              saveContentMut.mutate(
                { html, mjml, designJson: values },
                {
                  onSuccess: () => {
                    if (intent === 'advance') setStep(2);
                    else exitToBasic();
                  },
                },
              );
            };

            const handleExit = () => {
              if (helper.getState().pristine) {
                exitToBasic();
                return;
              }
              setExitConfirmOpen(true);
            };

            return (
              <FullscreenEmailEditor
                onExit={handleExit}
                banner={
                  isLegacyCampaign ? (
                    <div className="flex items-start gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-800">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>
                        此活动由旧编辑器创建,可视化数据已无法导入到 Easy Email。
                        当前画布为空白,保存后将覆盖旧的 HTML 内容。
                      </span>
                    </div>
                  ) : null
                }
                toolbar={
                  <>
                    {saveContentMut.isError && (
                      <div className="ml-auto mr-2 truncate text-xs text-destructive">
                        {apiErrMessage(saveContentMut.error)}
                      </div>
                    )}
                    <div
                      className={
                        'flex items-center gap-3 ' +
                        (saveContentMut.isError ? '' : 'ml-auto')
                      }
                    >
                      <Button
                        variant="outline"
                        onClick={() => setTemplatePickerOpen(true)}
                      >
                        <LayoutTemplate className="mr-1.5 size-4" />
                        选择模板
                      </Button>
                      <Button
                        onClick={() => persist('advance')}
                        disabled={saveContentMut.isPending}
                      >
                        {saveContentMut.isPending ? '保存中...' : '保存并下一步'}
                        <ArrowRight className="ml-1 size-4" />
                      </Button>
                    </div>
                  </>
                }
              >
                <div className="flex-1 overflow-hidden">
                  <StandardLayout categories={blockCategories} showSourceCode>
                    <EmailEditor />
                  </StandardLayout>
                </div>
                <ExitConfirmDialog
                  open={exitConfirmOpen}
                  saving={saveContentMut.isPending}
                  onClose={() => setExitConfirmOpen(false)}
                  onDiscard={exitToBasic}
                  onSave={() => persist('exit')}
                />
                <TemplatePickerDialog
                  open={templatePickerOpen}
                  templates={templates.data ?? []}
                  selectedTemplateId={selectedTemplateId}
                  blankSelected={blankSelected}
                  loading={templates.isLoading}
                  onClose={() => setTemplatePickerOpen(false)}
                  onPick={(pick) =>
                    requestTemplatePick(pick, !helper.getState().pristine)
                  }
                />
                <TemplateReplaceConfirmDialog
                  open={!!templateReplacePending}
                  onCancel={() => setTemplateReplacePending(null)}
                  onConfirm={() => {
                    if (templateReplacePending) commitTemplatePick(templateReplacePending);
                  }}
                />
              </FullscreenEmailEditor>
            );
          }}
        </EmailEditorProvider>
      </ConfigProvider>
    );
  }

  // Step 2 — preview & send (no stepper, two-column summary + schedule card).
  if (step === 2) {
    const selectedLists = (lists.data ?? []).filter((l) =>
      selectedListIds.includes(l.id),
    );
    const selectedSegments = (segments.data ?? []).filter((s) =>
      selectedSegmentIds.includes(s.id),
    );
    const hasAudience = selectedLists.length > 0 || selectedSegments.length > 0;
    const errMsg =
      finalizeMut.error && apiErrMessage(finalizeMut.error);

    return (
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" asChild className="shrink-0">
            <Link to="/campaigns" aria-label="返回列表">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Email 营销</h1>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="space-y-6 p-6">
              <SummarySection
                title="收件人"
                onEdit={() => setStep(0)}
                empty={!hasAudience ? '请选择收件人' : undefined}
              >
                {hasAudience && (
                  <div className="space-y-1">
                    {selectedLists.length > 0 && (
                      <div>
                        <span className="text-muted-foreground">列表:</span>{' '}
                        {selectedLists.map((l) => l.name).join('、')}
                      </div>
                    )}
                    {selectedSegments.length > 0 && (
                      <div>
                        <span className="text-muted-foreground">分群:</span>{' '}
                        {selectedSegments.map((s) => s.name).join('、')}
                      </div>
                    )}
                    <div className="text-muted-foreground">
                      预计 {formatNumber(totalRecipients)} 人(实际发送以后端去重为准)
                    </div>
                  </div>
                )}
              </SummarySection>
              <SummarySection title="主题" empty={!subject ? '主题不可为空' : undefined}>
                {subject && <div>{subject}</div>}
              </SummarySection>
              <SummarySection title="内文预览">
                {preheader ? (
                  <div>{preheader}</div>
                ) : (
                  <div className="text-muted-foreground">未设置</div>
                )}
              </SummarySection>
              <SummarySection title="寄件人">
                <div>
                  {derivedFromName ? `${derivedFromName} <${fromEmail}>` : fromEmail}
                  {fromEmails.length > 1 && (
                    <span className="text-muted-foreground">
                      {' '}
                      等 {fromEmails.length} 个发件人（轮流发送）
                    </span>
                  )}
                </div>
              </SummarySection>
              <SummarySection title="高级设置">
                <div className="font-medium text-foreground">
                  {utmCustomized
                    ? '启用自定义 UTM 数据追踪'
                    : '默认启用 UTM 数据追踪'}
                </div>
                <div className="mt-1 space-y-0.5 text-muted-foreground">
                  <div>
                    utm_source：{utmCustomized && utmSource ? utmSource : 'sendmast'}
                  </div>
                  <div>
                    utm_medium：{utmCustomized && utmMedium ? utmMedium : 'email'}
                  </div>
                  <div>
                    utm_campaign：
                    {utmCustomized && utmCampaign ? utmCampaign : '{{campaign_id}}'}
                  </div>
                  <div className="pt-1">
                    链接点击追踪：
                    <span
                      className={
                        'font-medium ' +
                        (trackClicks ? 'text-emerald-700' : 'text-foreground')
                      }
                    >
                      {trackClicks ? '已开启' : '已关闭（直达原落地页，UTM 仍按上方设置追加）'}
                    </span>
                  </div>
                </div>
              </SummarySection>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-6">
              <div className="flex items-start justify-between">
                <h2 className="text-base font-semibold">邮件内容</h2>
                <Button variant="outline" size="sm" onClick={() => setStep(1)}>
                  编辑
                </Button>
              </div>
              <div className="overflow-hidden rounded-md border bg-muted/20">
                <iframe
                  title="preview"
                  srcDoc={
                    editorHtml ??
                    '<p style="padding:20px;color:#888">请先在「编辑内容」步骤设计邮件</p>'
                  }
                  className="h-[480px] w-full"
                  sandbox="allow-same-origin"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="space-y-3 p-6">
            <h2 className="text-base font-semibold">发送时间</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={sendMode === 'now'}
                onChange={() => setSendMode('now')}
              />
              立即发送
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={sendMode === 'schedule'}
                onChange={() => setSendMode('schedule')}
              />
              定时发送
            </label>
            {sendMode === 'schedule' && (
              <div className="flex flex-wrap items-center gap-3 pl-6">
                <DateTimePicker
                  value={scheduleAt}
                  onChange={setScheduleAt}
                  className="w-[220px]"
                />
                <div className="flex h-9 w-[260px] items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                  您的时区 GMT+08:00 Asia/Shanghai
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {errMsg && (
          <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {errMsg}
          </div>
        )}

        {quotaExhausted && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              <span>
                当前账户发送额度为 0,无法发送活动。可先保存草稿,购买额度后再发送。
              </span>
            </div>
            <Button asChild size="sm" variant="outline" className="border-destructive/60 text-destructive hover:bg-destructive/10">
              <Link to="/settings/quota">购买额度</Link>
            </Button>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => saveDraftMut.mutate(undefined)}
            disabled={saveDraftMut.isPending || finalizeMut.isPending}
          >
            {saveDraftMut.isPending ? '保存中...' : '保存草稿'}
          </Button>
          {/* Wrap in a span so the native browser tooltip from `title` shows
              even while the Button is disabled (disabled <button> doesn't
              receive mouseenter on most browsers). */}
          <span
            title={
              quotaExhausted
                ? '发送额度为 0,不允许创建活动。请先购买额度。'
                : undefined
            }
          >
            <Button
              onClick={() => finalizeMut.mutate()}
              disabled={
                !sendableId ||
                finalizeMut.isPending ||
                saveDraftMut.isPending ||
                quotaExhausted ||
                (sendMode === 'schedule' && !scheduleAt)
              }
            >
              <Send className="mr-1 size-4" />
              {finalizeMut.isPending
                ? '发送中...'
                : sendMode === 'schedule'
                  ? '定时发送'
                  : '立即发送'}
            </Button>
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function SummarySection({
  title,
  empty,
  onEdit,
  children,
}: {
  title: string;
  empty?: string;
  onEdit?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        {onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            编辑
          </Button>
        )}
      </div>
      <div className="text-sm text-foreground">
        {empty ? <span className="text-destructive">{empty}</span> : children}
      </div>
    </div>
  );
}

function RecipientSelect({
  lists,
  segments,
  selectedLists,
  selectedSegments,
  onChangeLists,
  onChangeSegments,
}: {
  lists: ContactList[];
  segments: SegmentView[];
  selectedLists: string[];
  selectedSegments: string[];
  onChangeLists: (next: string[]) => void;
  onChangeSegments: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const pickedLists = lists.filter((l) => selectedLists.includes(l.id));
  const pickedSegments = segments.filter((s) => selectedSegments.includes(s.id));

  const q = query.trim().toLowerCase();
  const filteredLists = q ? lists.filter((l) => l.name.toLowerCase().includes(q)) : lists;
  const filteredSegments = q
    ? segments.filter((s) => s.name.toLowerCase().includes(q))
    : segments;

  // Close on outside click rather than the trigger's onBlur — an onBlur-based
  // close would fire the instant the in-dropdown search input takes focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggleList = (id: string) => {
    onChangeLists(
      selectedLists.includes(id)
        ? selectedLists.filter((x) => x !== id)
        : [...selectedLists, id],
    );
  };
  const toggleSegment = (id: string) => {
    onChangeSegments(
      selectedSegments.includes(id)
        ? selectedSegments.filter((x) => x !== id)
        : [...selectedSegments, id],
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex min-h-9 w-full items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-left text-sm transition-colors ' +
          (open ? 'border-primary' : 'border-input hover:border-primary/40')
        }
      >
        {pickedLists.length === 0 && pickedSegments.length === 0 ? (
          <span className="text-muted-foreground">选择收件人</span>
        ) : (
          <div className="flex flex-1 flex-wrap gap-1">
            {pickedLists.map((l) => (
              <RecipientChip
                key={`l-${l.id}`}
                kind="list"
                label={l.name}
                onRemove={() => toggleList(l.id)}
              />
            ))}
            {pickedSegments.map((s) => (
              <RecipientChip
                key={`s-${s.id}`}
                kind="segment"
                label={s.name}
                onRemove={() => toggleSegment(s.id)}
              />
            ))}
          </div>
        )}
        <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border bg-popover py-1 shadow-lg">
          <div className="sticky top-0 z-10 border-b bg-popover p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索列表 / 分群"
                className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none transition-colors focus:border-primary"
              />
            </div>
          </div>
          <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            联系人列表
          </div>
          {filteredLists.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {q ? '无匹配列表' : '无列表'}
            </div>
          ) : (
            filteredLists.map((l) => {
              const checked = selectedLists.includes(l.id);
              return (
                <div
                  key={l.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
                  onClick={() => toggleList(l.id)}
                >
                  <input type="checkbox" checked={checked} readOnly />
                  <div>
                    <div className="text-sm font-medium">{l.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatNumber(l.contactsCount)} 位联系人
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div className="mt-1 border-t" />
          <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            动态分群
          </div>
          {filteredSegments.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {q ? '无匹配分群' : '尚无分群。可前往"动态分群"页面创建。'}
            </div>
          ) : (
            filteredSegments.map((s) => {
              const checked = selectedSegments.includes(s.id);
              return (
                <div
                  key={s.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
                  onClick={() => toggleSegment(s.id)}
                >
                  <input type="checkbox" checked={checked} readOnly />
                  <div>
                    <div className="text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.cachedCount === null
                        ? '尚未刷新人数'
                        : `${formatNumber(s.cachedCount)} 位匹配`}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function RecipientChip({
  kind,
  label,
  onRemove,
}: {
  kind: 'list' | 'segment';
  label: string;
  onRemove: () => void;
}) {
  // Different chip colours so users can tell list-vs-segment at a glance.
  const cls =
    kind === 'list'
      ? 'bg-primary/10 text-primary hover:[&_.x]:bg-primary/20'
      : 'bg-emerald-100 text-emerald-800 hover:[&_.x]:bg-emerald-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${cls}`}>
      {kind === 'segment' && <span className="text-[10px] opacity-70">⚡</span>}
      {label}
      <span
        role="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="x cursor-pointer rounded p-0.5"
      >
        <X className="size-3" />
      </span>
    </span>
  );
}

function InboxPreview({
  fromName,
  subject,
  preheader,
}: {
  fromName: string;
  subject: string;
  preheader: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border bg-muted/30 p-2">
      <SkeletonRow />
      <SkeletonRow />
      <div className="rounded-md bg-white px-3 py-3 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="size-7 shrink-0 rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="truncate text-sm font-medium">{fromName || '寄件人姓名'}</div>
            <div className="truncate text-xs text-foreground">{subject || '主题'}</div>
            <div className="truncate text-xs text-muted-foreground">
              {preheader || '内文预览'}
            </div>
          </div>
        </div>
      </div>
      <SkeletonRow />
      <SkeletonRow />
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-3 opacity-50">
      <div className="size-7 shrink-0 rounded-full bg-muted" />
      <div className="flex-1 space-y-1.5">
        <div className="h-2 w-1/3 rounded bg-muted" />
        <div className="h-2 w-2/3 rounded bg-muted" />
      </div>
    </div>
  );
}

function ExitConfirmDialog({
  open,
  saving,
  onClose,
  onDiscard,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5">
          <div className="flex items-center gap-3">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <span className="text-sm font-bold leading-none">!</span>
            </div>
            <h2 className="text-base font-semibold">是否保存编辑</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted/40"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-8">
          <Button variant="outline" onClick={onDiscard} disabled={saving}>
            直接退出
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? '保存中...' : '保存并退出'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Big-button card used in the step-0 "邮件设计方式" picker. Two of these sit
 * side-by-side (拖放 / HTML). Modeled after the SendGrid pattern: large icon,
 * bold title, one-line description, prominent ring on the active option.
 */
function EditorModeCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'group relative flex flex-col items-center gap-2 rounded-lg border bg-background p-5 text-center transition ' +
        (active
          ? 'border-primary bg-primary/5 ring-2 ring-primary'
          : 'border-input hover:border-primary/40 hover:bg-muted/30')
      }
    >
      <div
        className={
          'flex size-12 items-center justify-center rounded-md ' +
          (active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')
        }
      >
        {icon}
      </div>
      <div className={'text-sm font-semibold ' + (active ? 'text-primary' : 'text-foreground')}>
        {title}
      </div>
      <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>
      {active && (
        <div className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </div>
      )}
    </button>
  );
}

function TemplatePickerDialog({
  open,
  templates,
  selectedTemplateId,
  blankSelected,
  loading,
  onClose,
  onPick,
}: {
  open: boolean;
  templates: Template[];
  selectedTemplateId: string | null;
  blankSelected: boolean;
  loading: boolean;
  onClose: () => void;
  onPick: (pick: { kind: 'template'; id: string } | { kind: 'blank' }) => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">选择模板</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              从空白开始，或选用系统/自定义模板作为起点
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted/40"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-auto p-5">
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">加载模板…</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <button
                type="button"
                onClick={() => onPick({ kind: 'blank' })}
                className={
                  'flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-md border border-dashed p-3 text-center transition-colors ' +
                  (blankSelected && !selectedTemplateId
                    ? 'border-primary bg-primary/5'
                    : 'border-input hover:border-primary/50 hover:bg-muted/40')
                }
              >
                <div className="flex size-10 items-center justify-center rounded-full bg-muted text-2xl text-muted-foreground">
                  +
                </div>
                <div className="text-sm font-medium">空白模板</div>
                <div className="text-xs text-muted-foreground">从零开始设计</div>
              </button>
              {templates.map((t) => {
                const selected = selectedTemplateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onPick({ kind: 'template', id: t.id })}
                    className={
                      'flex aspect-[4/3] flex-col justify-between rounded-md border p-3 text-left transition-colors ' +
                      (selected
                        ? 'border-primary bg-primary/5'
                        : 'hover:border-primary/50 hover:bg-muted/40')
                    }
                  >
                    <div className="text-sm font-medium">{t.name}</div>
                    <Badge variant={t.scope === 'system' ? 'muted' : 'default'} className="w-fit">
                      {t.scope === 'system' ? '系统' : '我的'}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateReplaceConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5">
          <div className="flex items-center gap-3">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
              <AlertTriangle className="size-4" />
            </div>
            <h2 className="text-base font-semibold">更换模板将清空当前内容</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-muted-foreground hover:bg-muted/40"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 pb-1 pt-3 text-sm text-muted-foreground">
          重新选择模板会清除编辑器中的现有邮件正文，此操作无法撤销。
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-6">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>确认更换</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirm dialog shown when the user picks a different editor mode in step 0
 * AFTER they've already saved body content (html / mjml / designJson) or
 * picked a template. Switching modes nukes those fields because the two
 * editors don't share state — see `confirmEditorModeChange`.
 */
function EditorModeSwitchDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: EditorMode | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!target) return null;
  const targetLabel = target === 'html' ? 'HTML 代码' : '拖放编辑器';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5">
          <div className="flex items-center gap-3">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
              <AlertTriangle className="size-4" />
            </div>
            <h2 className="text-base font-semibold">切换将清空当前邮件内容</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-muted-foreground hover:bg-muted/40"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 pb-1 pt-3 text-sm text-muted-foreground">
          切换到「{targetLabel}」会清空已编辑或导入的邮件正文(HTML / MJML / 设计数据),
          并重置已选择的模板。此操作无法撤销。
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-6">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>确认切换并清空</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen raw-HTML editor for `editorMode === 'html'`. Mirrors the
 * Easy Email step-2 chrome (top bar with 退出 / 保存并下一步) but the
 * canvas is a CodeMirror editor on the left + iframe live preview on the
 * right. The iframe re-renders on a 250ms debounce so typing stays smooth.
 */
function HtmlEditorStep({
  initialHtml,
  saving,
  saveError,
  onExit,
  onSave,
}: {
  initialHtml: string;
  saving: boolean;
  saveError: string | null;
  onExit: () => void;
  onSave: (html: string, intent: 'advance' | 'exit') => void;
}) {
  const [html, setHtml] = useState(initialHtml);
  const [previewSrc, setPreviewSrc] = useState(initialHtml);
  const [exitOpen, setExitOpen] = useState(false);

  // Debounce iframe updates so typing isn't laggy on big templates.
  useEffect(() => {
    const t = setTimeout(() => setPreviewSrc(html), 250);
    return () => clearTimeout(t);
  }, [html]);

  const dirty = html !== initialHtml;

  const handleExit = () => {
    if (!dirty) {
      onExit();
      return;
    }
    setExitOpen(true);
  };

  return (
    <FullscreenEmailEditor
      onExit={handleExit}
      toolbar={
        <>
          <span className="text-xs text-muted-foreground">HTML 模式</span>
          {saveError && (
            <div className="ml-auto mr-2 truncate text-xs text-destructive">{saveError}</div>
          )}
          <div className={saveError ? '' : 'ml-auto'}>
            <Button onClick={() => onSave(html, 'advance')} disabled={saving}>
              {saving ? '保存中...' : '保存并下一步'}
              <ArrowRight className="ml-1 size-4" />
            </Button>
          </div>
        </>
      }
    >
      <div className="grid flex-1 grid-cols-2 gap-0 overflow-hidden">
        <div className="flex min-h-0 flex-col border-r">
          <div className="border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            HTML 代码
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <CodeMirror
              value={html}
              extensions={[cmHtmlLang()]}
              onChange={(v) => setHtml(v)}
              height="100%"
              style={{ height: '100%', fontSize: 13 }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                highlightActiveLine: true,
              }}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            实时预览
          </div>
          <iframe
            title="HTML 预览"
            srcDoc={previewSrc}
            className="min-h-0 flex-1 bg-white"
            sandbox="allow-same-origin"
          />
        </div>
      </div>
      <ExitConfirmDialog
        open={exitOpen}
        saving={saving}
        onClose={() => setExitOpen(false)}
        onDiscard={() => {
          setExitOpen(false);
          onExit();
        }}
        onSave={() => onSave(html, 'exit')}
      />
    </FullscreenEmailEditor>
  );
}

// Multi-select for campaign sender addresses. Selection order is preserved
// (index 0 = primary); clicking an unchecked option appends it, clicking a
// checked one removes it. The campaign rotates through the picked addresses
// round-robin at send time.
type SenderOpt = { value: string; label: string; channelName?: string | null };

function SenderEmailSelect({
  values,
  onChange,
  options,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: SenderOpt[];
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedOptions = values
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is SenderOpt => !!o);
  const allSelected = options.length > 0 && values.length >= options.length;

  // Group by email channel only when the options carry an channelName (i.e. the
  // tenant spans multiple email channels). Single-channel tenants keep the flat list.
  const grouped = options.some((o) => o.channelName);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: SenderOpt[] }>();
    for (const o of options) {
      const key = o.channelName ?? '其他';
      const g = map.get(key) ?? { name: key, items: [] };
      g.items.push(o);
      map.set(key, g);
    }
    return Array.from(map.values());
  }, [options]);

  const toggle = (value: string) => {
    if (values.includes(value)) {
      onChange(values.filter((v) => v !== value));
    } else {
      onChange([...values, value]);
    }
  };

  const toggleAll = () => {
    onChange(allSelected ? [] : options.map((o) => o.value));
  };

  const toggleGroup = (items: SenderOpt[]) => {
    const gv = items.map((i) => i.value);
    const allSel = gv.every((v) => values.includes(v));
    if (allSel) onChange(values.filter((v) => !gv.includes(v)));
    else onChange(Array.from(new Set([...values, ...gv])));
  };

  const toggleCollapse = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const renderItem = (o: SenderOpt, inGroup: boolean) => {
    const isSelected = values.includes(o.value);
    return (
      <div
        key={o.value}
        onClick={() => toggle(o.value)}
        className={
          'flex cursor-pointer items-center gap-2 py-2 pr-3 text-sm transition-colors ' +
          (inGroup ? 'pl-8 ' : 'pl-3 ') +
          (isSelected
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-foreground hover:bg-muted/40')
        }
      >
        <span
          className={
            'flex size-4 shrink-0 items-center justify-center rounded border ' +
            (isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')
          }
        >
          {isSelected && <Check className="size-3" />}
        </span>
        <span className="flex-1 truncate">{o.label}</span>
        {!grouped && o.channelName && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {o.channelName}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm transition-colors ' +
          (open ? 'border-primary' : 'border-input hover:border-primary/40')
        }
      >
        {selectedOptions.length === 0 ? (
          <span className="text-muted-foreground">请选择...</span>
        ) : (
          <span className="truncate text-left text-foreground">
            {selectedOptions[0].label}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {selectedOptions.length > 1 && (
            <span className="text-xs text-muted-foreground">
              …等 {selectedOptions.length} 人
            </span>
          )}
          <ChevronDown className="size-4 text-muted-foreground" />
        </span>
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border bg-popover py-1 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div
            onClick={toggleAll}
            className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/40"
          >
            <span
              className={
                'flex size-4 shrink-0 items-center justify-center rounded border ' +
                (allSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')
              }
            >
              {allSelected && <Check className="size-3" />}
            </span>
            {allSelected ? '取消全选' : '全选'}
          </div>
          {grouped
            ? groups.map((g) => {
                const gv = g.items.map((i) => i.value);
                const selCount = gv.filter((v) => values.includes(v)).length;
                const allSel = selCount === gv.length && gv.length > 0;
                const someSel = selCount > 0 && !allSel;
                const isCollapsed = collapsed.has(g.name);
                return (
                  <div key={g.name} className="border-b last:border-0">
                    <div className="flex items-center gap-2 bg-muted/30 py-2 pl-3 pr-2 text-sm">
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(g.items);
                        }}
                        title={allSel ? '取消全选该分组' : '全选该分组'}
                        className={
                          'flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border ' +
                          (allSel
                            ? 'border-primary bg-primary text-primary-foreground'
                            : someSel
                              ? 'border-primary bg-primary/40'
                              : 'border-input')
                        }
                      >
                        {allSel ? (
                          <Check className="size-3" />
                        ) : someSel ? (
                          <span className="h-0.5 w-2 rounded bg-primary" />
                        ) : null}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleCollapse(g.name)}
                        className="flex flex-1 items-center justify-between gap-2 text-left"
                      >
                        <span className="truncate font-medium text-foreground">
                          {g.name}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            ({selCount}/{g.items.length})
                          </span>
                        </span>
                        <ChevronDown
                          className={
                            'size-4 shrink-0 text-muted-foreground transition-transform ' +
                            (isCollapsed ? '-rotate-90' : '')
                          }
                        />
                      </button>
                    </div>
                    {!isCollapsed && g.items.map((o) => renderItem(o, true))}
                  </div>
                );
              })
            : options.map((o) => renderItem(o, false))}
        </div>
      )}
    </div>
  );
}

// ----- DateTimePicker -----
// Lightweight custom datetime picker matching the SmartPush-style mockup:
// calendar (Monday-first, Chinese weekdays) + time list (hours, minutes) +
// 此刻 / 确定 footer. Value is the same `YYYY-MM-DDTHH:mm` string that
// <input type="datetime-local"> uses, so callers don't need a Date object.
function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function parseLocal(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function formatLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDisplay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // Monday-first: shift so Monday=0..Sunday=6.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function DateTimePicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const parsed = parseLocal(value);

  // Close when clicking outside the popup.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={containerRef} className={'relative ' + (className ?? '')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm transition-colors ' +
          (open ? 'border-primary' : 'border-input hover:border-primary/40')
        }
      >
        <span className={parsed ? 'text-foreground' : 'text-muted-foreground'}>
          {parsed ? formatDisplay(parsed) : '选择发送的日期和时间'}
        </span>
        <Calendar className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <DateTimePopup
          initial={parsed ?? new Date()}
          onConfirm={(d) => {
            onChange(formatLocalIso(d));
            setOpen(false);
          }}
          onPickNow={() => {
            const now = new Date();
            now.setSeconds(0, 0);
            onChange(formatLocalIso(now));
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DateTimePopup({
  initial,
  onConfirm,
  onPickNow,
}: {
  initial: Date;
  onConfirm: (d: Date) => void;
  onPickNow: () => void;
}) {
  const [pending, setPending] = useState<Date>(initial);
  const [display, setDisplay] = useState<Date>(
    new Date(initial.getFullYear(), initial.getMonth(), 1),
  );
  const hourListRef = useRef<HTMLDivElement>(null);
  const minListRef = useRef<HTMLDivElement>(null);

  const grid = useMemo(
    () => buildMonthGrid(display.getFullYear(), display.getMonth()),
    [display],
  );

  // Auto-scroll the selected hour/minute into view on first paint so the
  // user lands on what's currently selected rather than 00.
  useEffect(() => {
    hourListRef.current
      ?.querySelector<HTMLElement>(`[data-h="${pending.getHours()}"]`)
      ?.scrollIntoView({ block: 'center' });
    minListRef.current
      ?.querySelector<HTMLElement>(`[data-m="${pending.getMinutes()}"]`)
      ?.scrollIntoView({ block: 'center' });
    // run once on mount; pending changes inside the popup don't need re-scroll
  }, []);

  const navMonth = (delta: number) =>
    setDisplay((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  const navYear = (delta: number) =>
    setDisplay((d) => new Date(d.getFullYear() + delta, d.getMonth(), 1));

  const setDay = (d: Date) => {
    const next = new Date(pending);
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    setPending(next);
    if (d.getMonth() !== display.getMonth()) {
      setDisplay(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };
  const setHour = (h: number) => {
    const next = new Date(pending);
    next.setHours(h);
    setPending(next);
  };
  const setMin = (m: number) => {
    const next = new Date(pending);
    next.setMinutes(m);
    setPending(next);
  };

  const today = new Date();

  return (
    <div className="absolute bottom-full left-0 z-30 mb-1 flex flex-col rounded-md border bg-popover shadow-lg">
      <div className="flex">
        <div className="w-[280px] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1 text-muted-foreground">
              <button
                type="button"
                onClick={() => navYear(-1)}
                className="rounded p-1 hover:bg-muted/40"
                aria-label="上一年"
              >
                <ChevronsLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => navMonth(-1)}
                className="rounded p-1 hover:bg-muted/40"
                aria-label="上个月"
              >
                <ChevronLeft className="size-4" />
              </button>
            </div>
            <div className="text-sm font-medium">
              {display.getFullYear()}年 {display.getMonth() + 1}月
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              <button
                type="button"
                onClick={() => navMonth(1)}
                className="rounded p-1 hover:bg-muted/40"
                aria-label="下个月"
              >
                <ChevronRight className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => navYear(1)}
                className="rounded p-1 hover:bg-muted/40"
                aria-label="下一年"
              >
                <ChevronsRight className="size-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-y-0.5">
            {grid.map((d) => {
              const inMonth = d.getMonth() === display.getMonth();
              const selected = isSameDay(d, pending);
              const isToday = isSameDay(d, today);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  onClick={() => setDay(d)}
                  className={
                    'mx-auto flex size-8 items-center justify-center rounded text-xs transition-colors ' +
                    (selected
                      ? 'bg-primary text-primary-foreground'
                      : inMonth
                        ? 'text-foreground hover:bg-muted/60'
                        : 'text-muted-foreground/50 hover:bg-muted/30') +
                    (!selected && isToday ? ' ring-1 ring-primary/40' : '')
                  }
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex w-[120px] flex-col border-l">
          <div className="border-b px-3 py-2 text-center text-sm font-medium">
            {pad2(pending.getHours())}:{pad2(pending.getMinutes())}
          </div>
          <div className="flex h-[228px]">
            <div
              ref={hourListRef}
              className="flex-1 overflow-y-auto py-1 text-center text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => {
                const sel = h === pending.getHours();
                return (
                  <div
                    key={h}
                    data-h={h}
                    onClick={() => setHour(h)}
                    className={
                      'cursor-pointer py-1 transition-colors ' +
                      (sel
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'hover:bg-muted/40')
                    }
                  >
                    {pad2(h)}
                  </div>
                );
              })}
            </div>
            <div
              ref={minListRef}
              className="flex-1 overflow-y-auto border-l py-1 text-center text-sm"
            >
              {Array.from({ length: 60 }, (_, m) => {
                const sel = m === pending.getMinutes();
                return (
                  <div
                    key={m}
                    data-m={m}
                    onClick={() => setMin(m)}
                    className={
                      'cursor-pointer py-1 transition-colors ' +
                      (sel
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'hover:bg-muted/40')
                    }
                  >
                    {pad2(m)}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t px-3 py-2">
        <button
          type="button"
          onClick={onPickNow}
          className="text-sm text-primary hover:underline"
        >
          此刻
        </button>
        <Button size="sm" onClick={() => onConfirm(pending)}>
          确定
        </Button>
      </div>
    </div>
  );
}

/**
 * Tracks whether the viewport is below `md` (768px) so step 2 can swap in a
 * "go back to a desktop" message instead of mounting Easy Email or the
 * side-by-side HTML editor — both are upstream desktop-only flows.
 *
 * Subscribes via matchMedia rather than polling so a phone rotated to
 * landscape (or a tablet hitting the breakpoint) updates instantly.
 * SSR-safe (initial value falls back to false during render in non-browser
 * envs even though this app ships fully client-rendered).
 */
function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Older Safari uses addListener/removeListener; modern browsers use
    // addEventListener('change'). Try the modern path first.
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);
  return isMobile;
}

/**
 * Full-screen takeover shown when the user lands on step 2 from a phone.
 * Communicates *why* and gives two actions: go back to step 0 to keep
 * editing recipients/basics, or stay (the user can also rotate to landscape
 * on a tablet — matchMedia will re-evaluate and show the editor).
 */
function MobileEditorBlocker({
  mode,
  onBack,
}: {
  mode: EditorMode;
  onBack: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Monitor className="size-8" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">请在电脑上编辑邮件内容</h2>
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          {mode === 'html'
            ? 'HTML 编辑器需要左右分栏的代码与预览界面,在手机屏幕上无法正常使用。'
            : '可视化邮件编辑器(拖拽组件、自由排版)在手机屏幕上无法正常使用。'}
          <br />
          <br />
          您可以现在保存草稿,稍后在电脑上访问 SendMast 完成邮件设计。基本信息、收件人选择和发送步骤在手机上仍可正常操作。
        </p>
      </div>
      <Button onClick={onBack} className="w-full max-w-xs">
        <ArrowLeft className="mr-2 size-4" />
        返回基本信息
      </Button>
    </div>
  );
}
