import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function PersonalCenterDialog({ open, onClose }: Props) {
  const toast = useToast();
  const { user, account, setProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [accountName, setAccountName] = useState(account?.name ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (!open) return;
    setDisplayName(user?.displayName ?? '');
    setAccountName(account?.name ?? '');
  }, [account?.name, open, user?.displayName]);

  const profileMut = useMutation({
    mutationFn: async () => {
      const r = await api.patch('/api/auth/profile', {
        displayName: displayName.trim(),
        accountName: accountName.trim(),
      });
      return r.data;
    },
    onSuccess: (data) => {
      setProfile({
        user: data.user,
        account: data.account,
        impersonation: data.impersonation ?? null,
      });
      toast('资料已保存', 'success');
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const passwordMut = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { oldPassword, newPassword }),
    onSuccess: () => {
      toast('密码已更新,其它设备的登录会话已失效', 'success');
      resetPassword();
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const pending = profileMut.isPending || passwordMut.isPending;

  function resetPassword() {
    setOldPassword('');
    setNewPassword('');
    setConfirm('');
  }

  function close() {
    resetPassword();
    setDisplayName(user?.displayName ?? '');
    setAccountName(account?.name ?? '');
    onClose();
  }

  function saveProfile() {
    const name = displayName.trim();
    const workspaceName = accountName.trim();
    if (!name) return toast('请输入姓名', 'error');
    if (name.length > 80) return toast('姓名最多 80 个字符', 'error');
    if (!workspaceName) return toast('请输入工作区名称', 'error');
    if (workspaceName.length > 80) return toast('工作区名称最多 80 个字符', 'error');
    profileMut.mutate();
  }

  function savePassword() {
    if (!oldPassword) return toast('请输入当前密码', 'error');
    if (newPassword.length < 8) return toast('新密码至少 8 位', 'error');
    if (newPassword !== confirm) return toast('两次输入的新密码不一致', 'error');
    passwordMut.mutate();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !pending && close()}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">个人中心</h2>
          <Button size="icon" variant="ghost" disabled={pending} onClick={close}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-6 p-5">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">个人资料</h3>
            <Field label="登录邮箱">
              <Input value={user?.email ?? ''} disabled />
            </Field>
            <Field label="姓名">
              <Input
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveProfile()}
                disabled={pending}
              />
            </Field>
            <Field label="工作区名称">
              <Input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveProfile()}
                disabled={pending}
              />
            </Field>
            <div className="flex justify-end">
              <Button onClick={saveProfile} disabled={pending}>
                {profileMut.isPending ? '保存中…' : '保存资料'}
              </Button>
            </div>
          </section>

          <section className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-semibold">修改密码</h3>
            <Field label="当前密码">
              <Input
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                disabled={pending}
              />
            </Field>
            <Field label="新密码 (至少 8 位)">
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={pending}
              />
            </Field>
            <Field label="确认新密码">
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && savePassword()}
                disabled={pending}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              修改成功后,你在其它设备/浏览器上的登录会话将被强制下线,需要重新登录。
            </p>
            <div className="flex justify-end">
              <Button onClick={savePassword} disabled={pending}>
                {passwordMut.isPending ? '提交中…' : '确认修改'}
              </Button>
            </div>
          </section>
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
