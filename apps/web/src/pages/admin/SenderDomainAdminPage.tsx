import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

interface AdminSenderDomain {
  id: string;
  domain: string;
  status: 'provisioning' | 'pending' | 'verified' | 'failed';
  verifiedAt: string | null;
  createdAt: string;
  account: { id: string; name: string; slug: string };
  acsAccount: { id: string; name: string; status: string } | null;
}

export function SenderDomainAdminPage() {
  const { data: domains, isLoading } = useQuery<AdminSenderDomain[]>({
    queryKey: ['admin', 'sender-domains'],
    queryFn: async () => (await api.get('/api/admin/sender-domains')).data,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">发件域名(全平台)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          所有租户的已添加域名概览。每个域名的 ACS 账号在租户首次添加时由"租户管理"页的默认账号决定,无法在此页变更。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">租户</th>
                <th className="px-4 py-3 font-medium">域名</th>
                <th className="px-4 py-3 font-medium">域名状态</th>
                <th className="px-4 py-3 font-medium">绑定的 ACS 账号</th>
                <th className="px-4 py-3 font-medium">验证时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={5} />}
              {!isLoading && domains && domains.length === 0 && <EmptyStateRow colSpan={5} />}
              {domains?.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{d.account.name}</div>
                    <div className="text-xs text-muted-foreground">{d.account.slug}</div>
                  </td>
                  <td className="px-4 py-3 font-mono">{d.domain}</td>
                  <td className="px-4 py-3">
                    {d.status === 'verified' ? (
                      <Badge variant="success">已验证</Badge>
                    ) : d.status === 'provisioning' ? (
                      <Badge variant="muted">注册中</Badge>
                    ) : d.status === 'failed' ? (
                      <Badge variant="danger">注册失败</Badge>
                    ) : (
                      <Badge variant="warning">待验证</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {d.acsAccount ? d.acsAccount.name : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(d.verifiedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
