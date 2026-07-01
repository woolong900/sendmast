import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LockKeyhole, Mail, UserRound, X } from 'lucide-react';
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
  const profileUnchanged =
    displayName.trim() === (user?.displayName ?? '') &&
    accountName.trim() === (account?.name ?? '');

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4"
      onClick={() => !pending && close()}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {(user?.displayName ?? user?.email ?? '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">个人中心</h2>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Mail className="size-3.5 shrink-0" />
                <span className="truncate">{user?.email}</span>
              </div>
            </div>
          </div>
          <Button size="icon" variant="ghost" disabled={pending} onClick={close}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section className="rounded-lg bg-muted/25">
            <SectionHeader icon={<UserRound className="size-4" />} title="个人资料" />
            <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
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
              <Field label="登录邮箱" className="sm:col-span-2">
                <Input value={user?.email ?? ''} disabled className="bg-muted/40" />
              </Field>
            </div>
            <div className="flex items-center justify-end px-4 pb-4">
              <Button onClick={saveProfile} disabled={pending || profileUnchanged}>
                {profileMut.isPending ? '保存中…' : '保存资料'}
              </Button>
            </div>
          </section>

          <section className="rounded-lg bg-muted/25">
            <SectionHeader icon={<LockKeyhole className="size-4" />} title="修改密码" />
            <div className="space-y-4 px-4 pb-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="当前密码" className="sm:col-span-2">
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    disabled={pending}
                  />
                </Field>
                <Field label="新密码">
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
              </div>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                修改成功后,你在其它设备/浏览器上的登录会话将被强制下线,需要重新登录。
              </p>
            </div>
            <div className="flex items-center justify-end px-4 pb-4">
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

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-sm font-semibold">
      <span className="text-muted-foreground">{icon}</span>
      {title}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
