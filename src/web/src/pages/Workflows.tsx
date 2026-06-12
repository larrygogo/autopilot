import React, { useEffect, useState } from "react";
import { PAGE_W } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { NewWorkflowDialog } from "@/components/NewWorkflowDialog";
import { useNavigate } from "react-router-dom";
import { NewWorkflowFromTemplate } from "@/components/NewWorkflowFromTemplate";
import { WorkflowCatalog } from "@/components/WorkflowCatalog";
import { WorkflowHealthBanner } from "@/components/WorkflowHealthBanner";
import { PageHero } from "@/components/PageHero";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface WorkflowInfo {
  name: string;
  label?: string;
  description: string;
  source?: "db" | "file";
  derives_from?: string | null;
}

export function Workflows() {
  const toast = useToast();
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);

  const refresh = () => {
    setLoading(true);
    api
      .listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  // WS：daemon 重载工作流（修复孤儿 / discover 新增等）后自动同步列表
  useEffect(() => {
    const unsub = subscribe("daemon", (event) => {
      if (event.type === "workflow:reloaded") refresh();
    });
    return unsub;
  }, [subscribe]);

  if (loading) {
    return (
      <div className={cn(PAGE_W, "text-sm text-muted-foreground")}>
        加载中…
      </div>
    );
  }

  return (
    <div className={PAGE_W}>
      <PageHero
        title="工作流"
        subtitle="编排定义 · 阶段图谱"
        actions={
          <Button onClick={() => setTemplatePickerOpen(true)}>
            <Plus className="h-4 w-4" />
            新建工作流
          </Button>
        }
      />

      {/* 工作流目录健康检查：孤儿 / 重名碰撞 → 顶部警告条 + 修复 dialog */}
      <WorkflowHealthBanner onFixed={refresh} />

      {/* 用例目录视图：点卡片跳独立详情页 /workflows/:name */}
      <WorkflowCatalog
        workflows={workflows}
        onSelect={(name) => navigate(`/workflows/${encodeURIComponent(name)}`)}
        onClone={(name) => {
          setCloneSource(name);
          setCloneName(`${name}-copy`);
        }}
        onNew={() => setTemplatePickerOpen(true)}
      />

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => refresh()}
      />

      <NewWorkflowFromTemplate
        open={templatePickerOpen}
        onCancel={() => setTemplatePickerOpen(false)}
        onCreated={(_name) => {
          setTemplatePickerOpen(false);
          refresh();
        }}
        onFromScratch={() => {
          setTemplatePickerOpen(false);
          setNewOpen(true);
        }}
        onFromAI={() => {
          setTemplatePickerOpen(false);
          navigate("/workflows/new-with-ai");
        }}
      />

      <Dialog
        open={cloneSource !== null}
        onOpenChange={(v) => { if (!v && !cloning) { setCloneSource(null); setCloneName(""); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>克隆工作流 {cloneSource ?? ""}</DialogTitle>
            <DialogDescription>
              拷贝 yaml + ts 到新工作流目录；新工作流可以独立编辑、不影响原版。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="clone-name" className="bp-label">新名字</Label>
            <Input
              id="clone-name"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder="my-dev"
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCloneSource(null); setCloneName(""); }} disabled={cloning}>
              取消
            </Button>
            <Button
              onClick={async () => {
                if (!cloneSource || !cloneName.trim()) return;
                if (!/^[\w.\-]+$/.test(cloneName.trim())) {
                  toast.error("名字只允许字母 / 数字 / . _ -", "");
                  return;
                }
                setCloning(true);
                try {
                  // 用专门的"克隆已有工作流"API，而非 from-template（后者只克隆 examples 模板）
                  await api.cloneWorkflow(cloneSource, cloneName.trim());
                  toast.success(`已克隆 ${cloneSource} → ${cloneName.trim()}`);
                  setCloneSource(null);
                  setCloneName("");
                  refresh();
                } catch (e: unknown) {
                  toast.error("克隆失败", (e as Error)?.message ?? String(e));
                } finally {
                  setCloning(false);
                }
              }}
              disabled={cloning || !cloneName.trim()}
            >
              {cloning ? "克隆中..." : "克隆"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
