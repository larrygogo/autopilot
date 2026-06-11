import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";
import { api, type Project } from "@/hooks/useApi";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * Supabase 式顶栏项目切换器 —— 进入项目上下文后替代面包屑页标题。
 * 点击展开项目列表（当前项打勾），切换时保持所在 section；底部「新建项目」回项目列表页。
 */
export function ProjectSwitcher({
  projectId,
  section,
}: {
  projectId: string;
  section?: string;
}) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((list) => { if (!cancelled) setProjects(list); })
      .catch(() => { /* 静默：失败时下拉只有「新建项目」 */ });
    return () => { cancelled = true; };
  }, [projectId]);

  const current = projects.find((p) => p.id === projectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-muted">
        <Layers className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="truncate">{current?.name ?? projectId}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className="gap-2"
            onSelect={() =>
              navigate(section ? `/projects/${p.id}/${section}` : `/projects/${p.id}`)
            }
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.id}</span>
            {p.id === projectId && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2" onSelect={() => navigate("/library")}>
          <Plus className="h-3.5 w-3.5" />
          新建项目
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
