import { useNavigate } from "react-router-dom";
import { Plus, FolderPlus, GitBranch, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 全局「+」快捷创建菜单 — 挂在 header 右侧，任意页面一键创建需求 / 工作流 / 项目。
 *
 * 「新建任务」入口已移除（2026-06-12 pm 决策）：Web = 决策台，发起工作统一走
 * 「从需求开始」（澄清 → 审批 → 执行的完整闭环）；跳过两道闸的快捷发包是 CLI
 * 的母语（autopilot task start / run，后台仍自动建真需求）。
 */
export function QuickCreateMenu() {
  const navigate = useNavigate();

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
                <span className="hidden sm:inline text-[11px]">
                  新建
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建需求 / 工作流 / 项目</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => navigate("/start")}>
            <Sparkles className="h-3.5 w-3.5" />
            <span>从需求开始</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              AI 调研
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => navigate("/workflows?new=1")}>
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
    </>
  );
}
