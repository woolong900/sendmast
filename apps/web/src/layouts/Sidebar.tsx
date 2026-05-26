import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Send,
  Users,
  FileText,
  Globe,
  Settings,
  ServerCog,
  Network,
  Building2,
  Wallet,
  ListChecks,
  Mail,
  Tags,
  Filter,
  Receipt,
  Coins,
  Radio,
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { cn } from '@/lib/utils';
import { useAuth } from '@/store/auth';

interface NavGroup {
  label?: string;
  items: Array<{ to: string; label: string; icon: React.ReactNode; end?: boolean }>;
}

const BASE_NAV: NavGroup[] = [
  {
    items: [
      {
        to: '/dashboard',
        label: '仪表盘',
        icon: <LayoutDashboard className="size-4" />,
        end: true,
      },
    ],
  },
  {
    label: '营销',
    items: [
      { to: '/campaigns', label: '营销活动', icon: <Send className="size-4" /> },
      { to: '/contacts', label: '联系人', icon: <Users className="size-4" /> },
      { to: '/segments', label: '动态分群', icon: <Filter className="size-4" /> },
      { to: '/templates', label: '模板库', icon: <FileText className="size-4" /> },
    ],
  },
  {
    label: '设置',
    items: [
      { to: '/settings/domains', label: '发件域名', icon: <Globe className="size-4" /> },
      { to: '/settings/quota', label: '发送额度', icon: <Wallet className="size-4" /> },
      { to: '/settings/orders', label: '我的订单', icon: <Receipt className="size-4" /> },
      { to: '/settings/custom-tags', label: '自定义标签', icon: <Tags className="size-4" /> },
    ],
  },
];

const ADMIN_NAV: NavGroup = {
  label: '平台管理',
  items: [
    { to: '/admin/acs-accounts', label: 'ACS 账号', icon: <ServerCog className="size-4" /> },
    { to: '/admin/accounts', label: '租户管理', icon: <Building2 className="size-4" /> },
    { to: '/admin/sender-domains', label: '发件域名', icon: <Network className="size-4" /> },
    { to: '/admin/send-logs', label: '发送日志', icon: <ListChecks className="size-4" /> },
    { to: '/admin/system-mail', label: '系统邮件', icon: <Mail className="size-4" /> },
    { to: '/admin/quota-tiers', label: '套餐档位', icon: <Coins className="size-4" /> },
    { to: '/admin/tracking-domains', label: '追踪域名', icon: <Radio className="size-4" /> },
  ],
};

/**
 * Sidebar nav contents — renders branding header + groups + footer settings.
 * Intentionally does NOT include the outer <aside>/width/background so it can
 * be reused inside both the desktop sidebar (always visible md+) and the
 * mobile drawer (toggleable, full-height slide-in). Callers wrap it.
 *
 * `onNavigate` lets the mobile drawer close itself when a link is clicked;
 * desktop usage simply omits it.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { user } = useAuth();
  const groups = user?.isPlatformAdmin ? [...BASE_NAV, ADMIN_NAV] : BASE_NAV;
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-14 items-center gap-2 px-5">
        <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-accent">
          <BrandLogo className="size-4 text-sidebar-accent-foreground" />
        </div>
        <span className="text-base font-semibold tracking-tight">SendMast</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {groups.map((group, gi) => (
          <div key={gi} className="mb-4">
            {group.label && (
              <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider opacity-60">
                {group.label}
              </div>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                        'hover:bg-sidebar-accent/20',
                        isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                      )
                    }
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <NavLink
          to="/settings/domains"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-sidebar-accent/20"
        >
          <Settings className="size-4" />
          <span>设置</span>
        </NavLink>
      </div>
    </div>
  );
}
