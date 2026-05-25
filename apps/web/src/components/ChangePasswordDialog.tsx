import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ChangePasswordDialog({ open, onClose }: Props) {
  const toast = useToast();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const mut = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { oldPassword, newPassword }),
    onSuccess: () => {
      toast('密码已更新,其它设备的登录会话已失效', 'success');
      reset();
      onClose();
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  function reset() {
    setOldPassword('');
    setNewPassword('');
    setConfirm('');
  }

  function submit() {
    if (!oldPassword) return toast('请输入当前密码', 'error');
    if (newPassword.length < 8) return toast('新密码至少 8 位', 'error');
    if (newPassword !== confirm) return toast('两次输入的新密码不一致', 'error');
    mut.mutate();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !mut.isPending && (reset(), onClose())}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">修改密码</h2>
          <Button
            size="icon"
            variant="ghost"
            disabled={mut.isPending}
            onClick={() => {
              reset();
              onClose();
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="space-y-3 p-5">
          <Field label="当前密码">
            <Input
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              disabled={mut.isPending}
            />
          </Field>
          <Field label="新密码 (至少 8 位)">
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={mut.isPending}
            />
          </Field>
          <Field label="确认新密码">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              disabled={mut.isPending}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            修改成功后,你在其它设备/浏览器上的登录会话将被强制下线,需要重新登录。
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={mut.isPending}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending ? '提交中…' : '确认修改'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
