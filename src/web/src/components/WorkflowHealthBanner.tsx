import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Wrench, Loader2 } from "lucide-react";
import { api, type WorkflowHealthReport } from "@/hooks/useApi";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Term } from "@/components/Term";

/**
 * 工作流目录顶部的健康警告条带。
 *
 * 扫描 ~/.autopilot/workflows/ 找出：
 *   - 孤儿目录（workflow.yaml 顶层 name 跟目录名不一致 → registry 用 yaml.name 注册，UI 列表少条目 / 重名覆盖）
 *   - 重名碰撞（两个目录共用同一 yaml.name）
 *
 * 有问题时展示警告条 + 「修复」按钮，点击弹 dialog 列出每条孤儿可单独修复。
 */
export function WorkflowHealthBanner({ onFixed }: { onFixed?: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<WorkflowHealthReport | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fixingDir, setFixingDir] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.scanWorkflowHealth().then(setReport).catch(() => setReport(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function fix(dir: string) {
    setFixingDir(dir);
    try {
      const r = await api.fixOrphanWorkflow(dir);
      if (r.fixed) {
        toast.success(`已修复 ${dir}：${r.oldName} → ${r.newName}`);
        refresh();
        onFixed?.();
      } else {
        toast.info(`${dir} 已无需修复`);
      }
    } catch (e: unknown) {
      toast.error("修复失败", (e as Error)?.message ?? String(e));
    } finally {
      setFixingDir(null);
    }
  }

  async function fixAll(orphans: NonNullable<typeof report>["orphans"]) {
    setFixingDir("__all__");
    let okCount = 0;
    const errors: string[] = [];
    for (const o of orphans) {
      try {
        await api.fixOrphanWorkflow(o.dir);
        okCount += 1;
      } catch (e: unknown) {
        errors.push(`${o.dir}：${(e as Error)?.message ?? String(e)}`);
      }
    }
    setFixingDir(null);
    if (errors.length > 0) {
      toast.error(`已修复 ${okCount} 个，${errors.length} 个失败`, errors.join("\n"));
    } else {
      toast.success(`已批量修复 ${okCount} 个失联目录`);
    }
    refresh();
    onFixed?.();
  }

  if (!report) return null;
  const total = report.orphans.length + report.collisions.length;
  if (total === 0) return null;

  return (
    <>
      <div className="mb-4 rounded-lg border border-warning bg-warning/8 p-3">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <div className="flex-1 text-sm">
            <span className="font-bold text-warning">
              工作流目录检测到问题
            </span>
            <span className="ml-2 text-muted-foreground">
              {report.orphans.length > 0 && (
                <>
                  {report.orphans.length} 个<Term name="orphan_directory" />
                </>
              )}
              {report.orphans.length > 0 && report.collisions.length > 0 && "；"}
              {report.collisions.length > 0 && `${report.collisions.length} 组重名碰撞`}
              ；可能导致工作流不显示
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            <Wrench className="h-3.5 w-3.5" />
            查看 / 修复
          </Button>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>修复工作流目录问题</DialogTitle>
            <DialogDescription>
              修复会改写目标目录的 workflow.yaml 顶层 name 字段为目录名（不动其它字段、不动 ts 文件）。
              备份文件 workflow.yaml.bak 会自动生成。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-96 space-y-3 overflow-y-auto py-1">
            {report.orphans.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="bp-label text-muted-foreground">
                    失联目录 · orphan directory（{report.orphans.length}）
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fixAll(report.orphans)}
                    disabled={fixingDir !== null}
                  >
                    {fixingDir === "__all__" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                    全部修复
                  </Button>
                </div>
                <ul className="space-y-1.5">
                  {report.orphans.map((o) => (
                    <li
                      key={o.dir}
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="font-mono font-bold">{o.dir}/</div>
                        <div className="text-muted-foreground">
                          yaml 里 <code className="font-mono">name: {o.yamlName}</code> →
                          应改为 <code className="font-mono">name: {o.dir}</code>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fix(o.dir)}
                        disabled={fixingDir !== null}
                      >
                        {fixingDir === o.dir ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Wrench className="h-3 w-3" />
                        )}
                        修复
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {report.collisions.length > 0 && (
              <section>
                <h3 className="mb-2 bp-label text-muted-foreground">
                  重名碰撞（{report.collisions.length}）
                </h3>
                <ul className="space-y-1.5">
                  {report.collisions.map((c) => (
                    <li
                      key={c.name}
                      className="rounded-md border border-border bg-card px-3 py-2 text-xs"
                    >
                      <div className="mb-0.5 font-mono font-bold">name: {c.name}</div>
                      <div className="text-muted-foreground">
                        共享此 name 的目录：
                        <code className="ml-1 font-mono">{c.dirs.join(" / ")}</code>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        修复失联目录后碰撞会自动消失；如确实要保留多个同源副本，请手工把 yaml.name 改成不同值
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
