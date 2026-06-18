import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, Headphones, KeyRound, LogOut, Mail, Menu, X } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';
import { formatNumber, cn } from '@/lib/utils';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { useQuota } from '@/hooks/useQuota';

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void } = {}) {
  const { user, refreshToken, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const supportRef = useRef<HTMLDivElement>(null);

  const { data: quota } = useQuota();

  // Close floating menus on outside click / ESC.
  useEffect(() => {
    if (!menuOpen && !supportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (supportRef.current && !supportRef.current.contains(e.target as Node)) {
        setSupportOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      setSupportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, supportOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    if (refreshToken) {
      await api.post('/api/auth/logout', { refreshToken }).catch(() => undefined);
    }
    logout();
    navigate('/login', { replace: true });
  }

  const remaining = quota?.remaining ?? 0;
  const tone =
    remaining === 0
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : remaining < 1000
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-border bg-muted/40 text-muted-foreground';

  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4 sm:px-6">
      {/* Hamburger — only visible below md; tap target 44×44 for iOS/Android. */}
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label="打开导航菜单"
        className="-ml-2 flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground md:hidden"
      >
        <Menu className="size-5" />
      </button>
      {/* Desktop spacer — pushes the right group flush right via justify-between
          when the hamburger is hidden. md:block so it only takes space at md+. */}
      <div className="hidden md:block" />
      <div className="flex items-center gap-3">
        <Link
          to="/settings/quota"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:opacity-80',
            tone,
          )}
          title="点击查看发送额度详情"
        >
          <Mail className="size-3.5" />
          <span>剩余 {formatNumber(remaining)}</span>
        </Link>

        <div ref={supportRef} className="relative">
          <button
            type="button"
            onClick={() => {
              setSupportOpen((o) => !o);
              setMenuOpen(false);
            }}
            aria-expanded={supportOpen}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <Headphones className="size-4" />
            <span className="hidden sm:inline">客服</span>
          </button>

          {supportOpen && (
            <div className="fixed right-3 top-16 z-50 w-[calc(100vw-1.5rem)] max-w-[360px] overflow-hidden rounded-lg border bg-popover shadow-xl sm:right-6">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="text-sm font-semibold">联系客服</div>
                <button
                  type="button"
                  onClick={() => setSupportOpen(false)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="关闭客服窗口"
                >
                  <X className="size-5" />
                </button>
              </div>
              <div className="grid grid-cols-[1fr_132px] items-center gap-4 p-4">
                <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <div>
                    <div className="mb-1 font-semibold text-foreground">微信客服</div>
                    <p>扫码添加客服咨询。</p>
                  </div>
                  <div className="rounded-md bg-muted/40 px-2.5 py-2 text-foreground">
                    微信号: <span className="font-semibold">haoke500</span>
                  </div>
                </div>
                <div className="w-[132px] rounded-md border bg-white p-1.5">
                  <img
                    src="/assets/support/wechat-haoke500.png"
                    alt="客服微信二维码"
                    className="block size-[120px] object-contain"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-md px-1.5 py-1"
          >
            <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {(user?.displayName ?? user?.email ?? '?').charAt(0).toUpperCase()}
            </div>
            {/* Hide name on phones — avatar + chevron are enough; full name + email
                don't fit alongside the quota pill at <640px. */}
            <span className="hidden text-sm font-medium sm:inline">{user?.displayName ?? user?.email}</span>
            <ChevronDown
              className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                menuOpen && 'rotate-180',
              )}
            />
          </button>

          {menuOpen && (
            // Right-align + min-width: on phones the trigger collapses to just
            // avatar+chevron (~50px), and `left-0 right-0` would force the
            // dropdown to that width, stacking Chinese characters vertically
            // (see screenshot from 2026-05-26). Anchoring to the right edge
            // lets the menu grow leftward into the page instead.
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border bg-popover py-1 shadow-md">
              <MenuItem
                icon={<KeyRound className="size-4" />}
                label="修改密码"
                onClick={() => {
                  setMenuOpen(false);
                  setPwOpen(true);
                }}
              />
              <div className="my-1 border-t" />
              <MenuItem
                icon={<LogOut className="size-4" />}
                label="退出登录"
                onClick={handleLogout}
                danger
              />
            </div>
          )}
        </div>
      </div>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </header>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
