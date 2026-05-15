import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, FilePlus, FolderPlus, GitBranch, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NewTaskDialog } from "@/components/NewTaskDialog";
import { NewWorkflowFromTemplate } from "@/components/NewWorkflowFromTemplate";
import { NewWorkflowDialog } from "@/components/NewWorkflowDialog";

/**
 * 全局「+」快捷创建菜单 — 挂在 header 右侧，任意页面一键创建任务 / 工作流 / 项目。
 *
 * 解决 PM 报告里的"新建入口分散"问题：之前要建任务得进 /start，
 * 建工作流得进 /workflows，建项目得进 /library，分散且不可发现。
 */
export function QuickCreateMenu() {
  const navigate = useNavigate();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 pr-2"
                aria-label="新建"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline font-mono text-[11px] uppercase tracking-[0.12em]">
                  新建
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建任务 / 工作流 / 项目</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setNewTaskOpen(true)}>
            <FilePlus className="h-3.5 w-3.5" />
            <span>新任务</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              直接跑
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/start")}>
            <Sparkles className="h-3.5 w-3.5" />
            <span>从需求开始</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              AI 调研
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setTemplatePickerOpen(true)}>
            <GitBranch className="h-3.5 w-3.5" />
            <span>新工作流</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              选模板
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => navigate("/library")}>
            <FolderPlus className="h-3.5 w-3.5" />
            <span>新项目</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              进项目页
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onCreated={(id) => {
          setNewTaskOpen(false);
          navigate(`/tasks/${id}`);
        }}
      />

      <NewWorkflowFromTemplate
        open={templatePickerOpen}
        onCancel={() => setTemplatePickerOpen(false)}
        onCreated={(_name) => {
          setTemplatePickerOpen(false);
          navigate("/workflows");
        }}
        onFromScratch={() => {
          setTemplatePickerOpen(false);
          setNewWorkflowOpen(true);
        }}
        onFromAI={() => {
          setTemplatePickerOpen(false);
          navigate("/workflows/new-with-ai");
        }}
      />

      <NewWorkflowDialog
        open={newWorkflowOpen}
        onClose={() => setNewWorkflowOpen(false)}
        onCreated={() => {
          setNewWorkflowOpen(false);
          navigate("/workflows");
        }}
      />
    </>
  );
}
