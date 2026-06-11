import { type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VariablesHelper } from '@/components/VariablesHelper';

/**
 * Shared chrome for the fullscreen email editors (template / campaign /
 * automation). Renders the fixed overlay and the top toolbar with a consistent
 * "退出编辑" button + variables helper on the left, and caller-provided content
 * (e.g. 选择模板 / 预览 / 保存) after them.
 *
 * The toolbar uses symmetric `px-4` padding so the exit button's left gap
 * matches the save button's right gap.
 */
export function FullscreenEmailEditor({
  onExit,
  toolbar,
  banner,
  children,
}: {
  onExit: () => void;
  /** Toolbar content placed after the exit button + variables helper. */
  toolbar?: ReactNode;
  /** Optional full-width banner shown directly under the toolbar. */
  banner?: ReactNode;
  /** Editor body (StandardLayout/EmailEditor, code panes, dialogs, …). */
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
        <Button variant="outline" onClick={onExit}>
          <LogOut className="mr-1.5 size-4" />
          退出编辑
        </Button>
        <VariablesHelper variant="button" size="default" />
        {toolbar}
      </div>
      {banner}
      {children}
    </div>
  );
}
