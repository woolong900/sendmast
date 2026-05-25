import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  X,
  UploadCloud,
  Download,
  FileText,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, apiErrMessage } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

const REQUIRED_COLUMNS = ['email'];
const OPTIONAL_COLUMNS = [
  'first_name',
  'last_name',
  'phone',
  'gender',
  'country',
  'state',
  'city',
  'zip',
  'language',
];

const TEMPLATE_SAMPLE_ROWS: string[][] = [
  ['jane.doe@example.com', 'Jane', 'Doe', '+1 415 555 1234', 'female', 'US', 'CA', 'San Francisco', '94107', 'en'],
  ['li.lei@example.cn', '雷', '李', '+86 138 0000 0000', 'male', 'CN', '上海', '上海', '200000', 'zh'],
];

function downloadTemplate() {
  const headers = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];
  const lines = [headers.join(','), ...TEMPLATE_SAMPLE_ROWS.map((r) => r.join(','))];
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sendmast-contacts-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface ImportJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalRows: number | null;
  processedRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedRows: number;
  errorMessage: string | null;
}

export function ImportContactsDialog({
  listId,
  onClose,
  onDone,
}: {
  listId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('listId', listId);
      fd.append('overwriteExisting', overwriteExisting ? 'true' : 'false');
      const r = await api.post('/api/imports/contacts', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return r.data as ImportJob;
    },
    onSuccess: (job) => setJobId(job.id),
  });

  const job = useQuery<ImportJob>({
    queryKey: ['import-job', jobId],
    queryFn: async () => (await api.get(`/api/imports/${jobId}`)).data,
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 800;
    },
  });

  useEffect(() => {
    if (job.data?.status === 'completed') {
      const t = setTimeout(onDone, 1200);
      return () => clearTimeout(t);
    }
  }, [job.data?.status, onDone]);

  const totalRows = job.data?.totalRows ?? null;
  const processed = job.data?.processedRows ?? 0;
  const knownTotal = totalRows != null && totalRows > 0;
  const pct = knownTotal ? Math.min(100, Math.round((processed / totalRows) * 100)) : 0;

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') return;
    setFile(f);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b px-6 pt-5 pb-4">
          <div>
            <h2 className="text-lg font-semibold leading-none">从 CSV 导入联系人</h2>
            <p className="mt-1.5 text-xs text-muted-foreground">
              单文件最大 200MB，UTF-8 编码；首行需为列名。
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} className="-mr-2">
            <X className="size-4" />
          </Button>
        </div>

        <div className="p-6">
          {!jobId && (
            <div className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3">
                <div className="text-sm">
                  <div className="font-medium">不知道格式？</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">下载模板，填入数据再上传</div>
                </div>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-background px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                >
                  <Download className="size-3.5" />
                  下载模板
                </button>
              </div>

              <div
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  pickFile(e.dataTransfer.files?.[0]);
                }}
                className={`group flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  dragOver
                    ? 'border-primary bg-primary/5'
                    : file
                      ? 'border-emerald-300 bg-emerald-50/50'
                      : 'border-border hover:border-primary/40 hover:bg-muted/40'
                }`}
              >
                {file ? (
                  <>
                    <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                      <FileText className="size-6" />
                    </div>
                    <div className="mt-3 text-sm font-medium">{file.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{formatBytes(file.size)}</div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                        if (fileInput.current) fileInput.current.value = '';
                      }}
                      className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <RefreshCw className="size-3" />
                      重新选择
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                      <UploadCloud className="size-6" />
                    </div>
                    <div className="mt-3 text-sm font-medium">点击或拖拽 CSV 文件到此处</div>
                    <div className="mt-1 text-xs text-muted-foreground">仅支持 .csv 格式</div>
                  </>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </div>

              <div className="rounded-lg border bg-muted/30 px-4 py-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">CSV 列要求</div>
                <div className="flex flex-wrap gap-1.5">
                  {REQUIRED_COLUMNS.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary"
                    >
                      {c}
                      <span className="text-[9px] text-primary/70">必填</span>
                    </span>
                  ))}
                  {OPTIONAL_COLUMNS.map((c) => (
                    <span
                      key={c}
                      className="rounded-md bg-background px-2 py-0.5 text-xs font-mono text-muted-foreground ring-1 ring-inset ring-border"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-input p-3.5 text-sm hover:border-primary/40 hover:bg-muted/30">
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  onChange={(e) => setOverwriteExisting(e.target.checked)}
                  className="mt-0.5 size-4 cursor-pointer rounded border-input accent-primary"
                />
                <div>
                  <div className="font-medium">覆盖已存在的相同邮箱联系人</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    勾选后会用 CSV 中的字段更新已有联系人。<br />
                    不勾选则保留原始数据，只把他们追加到当前列表。
                  </div>
                </div>
              </label>

              {upload.isError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{apiErrMessage(upload.error)}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={onClose}>
                  取消
                </Button>
                <Button
                  disabled={!file || upload.isPending}
                  onClick={() => file && upload.mutate(file)}
                >
                  {upload.isPending ? '上传中...' : '开始导入'}
                </Button>
              </div>
            </div>
          )}

          {jobId && job.data && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusBadge status={job.data.status} />
                  {job.data.status === 'processing' && (
                    <span className="text-xs text-muted-foreground">
                      {knownTotal
                        ? `${formatNumber(processed)} / ${formatNumber(totalRows!)} 行`
                        : `${formatNumber(processed)} 行 · 统计中…`}
                    </span>
                  )}
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {knownTotal || job.data.status === 'completed' ? (
                    <>
                      {pct}
                      <span className="text-base font-normal text-muted-foreground">%</span>
                    </>
                  ) : (
                    <span className="text-base font-normal text-muted-foreground">—</span>
                  )}
                </div>
              </div>

              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                {knownTotal || job.data.status === 'completed' || job.data.status === 'failed' ? (
                  <div
                    className={`h-full transition-all duration-300 ${
                      job.data.status === 'failed'
                        ? 'bg-destructive'
                        : job.data.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-primary'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
                )}
              </div>

              <div className="grid grid-cols-4 gap-3">
                <Stat label="新增" value={job.data.insertedRows} tone="primary" />
                <Stat label="更新" value={job.data.updatedRows} tone="info" />
                <Stat label="跳过" value={job.data.skippedRows} tone="muted" />
                <Stat label="总行数" value={totalRows ?? 0} tone="muted" />
              </div>

              {job.data.status === 'failed' && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{job.data.errorMessage ?? '导入失败'}</span>
                </div>
              )}

              {job.data.status === 'completed' && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  <span>导入完成，正在刷新列表…</span>
                </div>
              )}

              {(job.data.status === 'completed' || job.data.status === 'failed') && (
                <div className="flex justify-end border-t pt-4">
                  <Button variant="outline" onClick={onClose}>
                    关闭
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ImportJob['status'] }) {
  const map: Record<ImportJob['status'], { label: string; cls: string }> = {
    pending: { label: '排队中', cls: 'bg-amber-100 text-amber-700' },
    processing: { label: '处理中', cls: 'bg-blue-100 text-blue-700' },
    completed: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700' },
    failed: { label: '失败', cls: 'bg-destructive/10 text-destructive' },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${m.cls}`}
    >
      {status === 'processing' && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {m.label}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'primary' | 'info' | 'muted';
}) {
  const cls =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'info'
        ? 'text-blue-600'
        : 'text-foreground';
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${cls}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}
