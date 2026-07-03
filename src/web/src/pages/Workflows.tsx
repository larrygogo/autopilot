import React, { useEffect, useState } from "react";
import { FormDialog, FormField, PageShell } from "@/components/pro";
import { Plus } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NewWorkflowFromTemplate } from "@/components/NewWorkflowFromTemplate";
import { WorkflowCatalog } from "@/components/WorkflowCatalog";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { subscribe } = useWebSocket();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("");

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

  // 顶栏 QuickCreate「新工作流」导航过来时带 ?new=1：自动打开入口弹窗，
  // 入口组件只在本页实例化一份（QuickCreate 只做导航快捷方式，不再自实例化）。
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setTemplatePickerOpen(true);
      searchParams.delete("new");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // WS：daemon 重载工作流（修复孤儿 / discover 新增等）后自动同步列表
  useEffect(() => {
    const unsub = subscribe("daemon", (event) => {
      if (event.type === "workflow:reloaded") refresh();
    });
    return unsub;
  }, [subscribe]);

  return (
    <PageShell
      width="content"
      loading={loading}
      hero={{
        title: "工作流",
        subtitle: "编排定义 · 阶段图谱",
        actions: (
          <Button onClick={() => setTemplatePickerOpen(true)}>
            <Plus className="h-4 w-4" />
            新建工作流
          </Button>
        ),
      }}
    >

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

      <NewWorkflowFromTemplate
        open={templatePickerOpen}
        onCancel={() => setTemplatePickerOpen(false)}
        onCreated={(name) => {
          setTemplatePickerOpen(false);
          // 模板 / 导入 / 从零都汇流到详情页，与 AI 路径一致（创建即落地→进编辑场）
          navigate(`/workflows/${encodeURIComponent(name)}`);
        }}
        onFromAI={() => {
          setTemplatePickerOpen(false);
          navigate("/workflows/new-with-ai");
        }}
      />

      <FormDialog
        open={cloneSource !== null}
        onOpenChange={(v) => { if (!v) { setCloneSource(null); setCloneName(""); } }}
        title={`克隆工作流 ${cloneSource ?? ""}`}
        description="拷贝 yaml + ts 到新工作流目录；新工作流可以独立编辑、不影响原版。"
        submitText="克隆"
        submitDisabled={!cloneName.trim()}
        onSubmit={async () => {
          if (!cloneSource) return;
          if (!/^[\w.\-]+$/.test(cloneName.trim())) {
            throw new Error("名字只允许字母 / 数字 / . _ -");
          }
          // 用专门的"克隆已有工作流"API，而非 from-template（后者只克隆 examples 模板）
          const target = cloneName.trim();
          await api.cloneWorkflow(cloneSource, target);
          toast.success(`已克隆 ${cloneSource} → ${target}`);
          setCloneName("");
          // 与新建主链路一致：克隆后进新工作流详情页（而非停列表）
          navigate(`/workflows/${encodeURIComponent(target)}`);
        }}
      >
        <FormField label="新名字" htmlFor="clone-name">
          <Input
            id="clone-name"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            placeholder="my-dev"
            className="font-mono"
          />
        </FormField>
      </FormDialog>
    </PageShell>
  );
}
