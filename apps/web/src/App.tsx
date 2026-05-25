import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { ToastProvider } from '@/components/ui/toast';
import { Layout } from '@/layouts/Layout';
import { useAuth } from '@/store/auth';

// Route-level code splitting. Heavy pages — CampaignWizardPage and
// TemplateEditorPage in particular, which pull in react-email-editor (~1.5MB
// gzipped) — must NOT be in the initial bundle. Vite/esbuild will emit one
// chunk per dynamic import so the login screen ships only what it needs.
//
// All pages are exported as named symbols, so we adapt them via the
// `.then(m => ({ default: m.X }))` shim that React.lazy requires.
const LoginPage = lazy(() =>
  import('@/pages/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const SignupPage = lazy(() =>
  import('@/pages/auth/SignupPage').then((m) => ({ default: m.SignupPage })),
);
const ForgotPasswordPage = lazy(() =>
  import('@/pages/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('@/pages/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const ActivatePage = lazy(() =>
  import('@/pages/auth/ActivatePage').then((m) => ({ default: m.ActivatePage })),
);
const DashboardPage = lazy(() =>
  import('@/pages/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const CampaignListPage = lazy(() =>
  import('@/pages/campaigns/CampaignListPage').then((m) => ({ default: m.CampaignListPage })),
);
const CampaignDetailPage = lazy(() =>
  import('@/pages/campaigns/CampaignDetailPage').then((m) => ({ default: m.CampaignDetailPage })),
);
const CampaignAnalyticsPage = lazy(() =>
  import('@/pages/campaigns/CampaignAnalyticsPage').then((m) => ({
    default: m.CampaignAnalyticsPage,
  })),
);
const CampaignRecipientsPage = lazy(() =>
  import('@/pages/campaigns/CampaignRecipientsPage').then((m) => ({
    default: m.CampaignRecipientsPage,
  })),
);
const CampaignWizardPage = lazy(() =>
  import('@/pages/campaigns/CampaignWizardPage').then((m) => ({ default: m.CampaignWizardPage })),
);
const ContactListsPage = lazy(() =>
  import('@/pages/contacts/ContactListsPage').then((m) => ({ default: m.ContactListsPage })),
);
const ContactListDetailPage = lazy(() =>
  import('@/pages/contacts/ContactListDetailPage').then((m) => ({
    default: m.ContactListDetailPage,
  })),
);
const SegmentsPage = lazy(() =>
  import('@/pages/segments/SegmentsPage').then((m) => ({ default: m.SegmentsPage })),
);
const SegmentEditPage = lazy(() =>
  import('@/pages/segments/SegmentEditPage').then((m) => ({ default: m.SegmentEditPage })),
);
const TemplatesPage = lazy(() =>
  import('@/pages/templates/TemplatesPage').then((m) => ({ default: m.TemplatesPage })),
);
const TemplateEditorPage = lazy(() =>
  import('@/pages/templates/TemplateEditorPage').then((m) => ({ default: m.TemplateEditorPage })),
);
const SenderDomainsPage = lazy(() =>
  import('@/pages/settings/SenderDomainsPage').then((m) => ({ default: m.SenderDomainsPage })),
);
const SenderDomainAddPage = lazy(() =>
  import('@/pages/settings/SenderDomainAddPage').then((m) => ({ default: m.SenderDomainAddPage })),
);
const QuotaPage = lazy(() =>
  import('@/pages/settings/QuotaPage').then((m) => ({ default: m.QuotaPage })),
);
const CustomTagsPage = lazy(() =>
  import('@/pages/settings/CustomTagsPage').then((m) => ({ default: m.CustomTagsPage })),
);
const AcsAccountListPage = lazy(() =>
  import('@/pages/admin/AcsAccountListPage').then((m) => ({ default: m.AcsAccountListPage })),
);
const SenderDomainAdminPage = lazy(() =>
  import('@/pages/admin/SenderDomainAdminPage').then((m) => ({ default: m.SenderDomainAdminPage })),
);
const AdminAccountsPage = lazy(() =>
  import('@/pages/admin/AdminAccountsPage').then((m) => ({ default: m.AdminAccountsPage })),
);
const SendLogsAdminPage = lazy(() =>
  import('@/pages/admin/SendLogsAdminPage').then((m) => ({ default: m.SendLogsAdminPage })),
);
const SystemMailAdminPage = lazy(() =>
  import('@/pages/admin/SystemMailAdminPage').then((m) => ({ default: m.SystemMailAdminPage })),
);
const OrdersPage = lazy(() =>
  import('@/pages/settings/OrdersPage').then((m) => ({ default: m.OrdersPage })),
);
const AdminQuotaTiersPage = lazy(() =>
  import('@/pages/admin/AdminQuotaTiersPage').then((m) => ({ default: m.AdminQuotaTiersPage })),
);

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequirePlatformAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.isPlatformAdmin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

/** Minimal placeholder while a route chunk loads — usually <200ms on warm cache. */
function RouteFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/activate" element={<ActivatePage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />

              <Route path="contacts" element={<ContactListsPage />} />
              <Route path="contacts/lists/:listId" element={<ContactListDetailPage />} />

              <Route path="segments" element={<SegmentsPage />} />
              <Route path="segments/new" element={<SegmentEditPage />} />
              <Route path="segments/:id/edit" element={<SegmentEditPage />} />

              <Route path="campaigns" element={<CampaignListPage />} />
              <Route path="campaigns/new" element={<CampaignWizardPage />} />
              <Route path="campaigns/:id/edit" element={<CampaignWizardPage />} />
              <Route path="campaigns/:id" element={<CampaignDetailPage />} />
              <Route path="campaigns/:id/analytics" element={<CampaignAnalyticsPage />} />
              <Route path="campaigns/:id/recipients" element={<CampaignRecipientsPage />} />

              <Route path="templates" element={<TemplatesPage />} />
              <Route path="templates/new" element={<TemplateEditorPage />} />
              <Route path="templates/:id/edit" element={<TemplateEditorPage />} />

              <Route path="settings/domains" element={<SenderDomainsPage />} />
              <Route path="settings/domains/new" element={<SenderDomainAddPage />} />
              <Route path="settings/quota" element={<QuotaPage />} />
              <Route path="settings/orders" element={<OrdersPage />} />
              <Route path="settings/custom-tags" element={<CustomTagsPage />} />

              <Route
                path="admin/acs-accounts"
                element={
                  <RequirePlatformAdmin>
                    <AcsAccountListPage />
                  </RequirePlatformAdmin>
                }
              />
              <Route
                path="admin/accounts"
                element={
                  <RequirePlatformAdmin>
                    <AdminAccountsPage />
                  </RequirePlatformAdmin>
                }
              />
              <Route
                path="admin/sender-domains"
                element={
                  <RequirePlatformAdmin>
                    <SenderDomainAdminPage />
                  </RequirePlatformAdmin>
                }
              />
              <Route
                path="admin/send-logs"
                element={
                  <RequirePlatformAdmin>
                    <SendLogsAdminPage />
                  </RequirePlatformAdmin>
                }
              />
              <Route
                path="admin/system-mail"
                element={
                  <RequirePlatformAdmin>
                    <SystemMailAdminPage />
                  </RequirePlatformAdmin>
                }
              />
              <Route
                path="admin/quota-tiers"
                element={
                  <RequirePlatformAdmin>
                    <AdminQuotaTiersPage />
                  </RequirePlatformAdmin>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
