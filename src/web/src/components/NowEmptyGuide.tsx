import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FolderPlus, FilePlus, ListChecks, Sparkles, CheckCircle2 } from "lucide-react";
import { api } from "@/hooks/useApi";
import { Card } from "@/components/ui/card";

interface Counts {
  projects: number;
  running: number;
  totalTasks: number;
}

/**
 * Now 空态智能引导。
 *
 * 解决 PM 报告"首次进来什么也看不见的空白焦虑"：
 * - 没项目 → 引导建项目
 * - 有项目没任务 → 引导开始任务
 * - 有任务在跑（Now 看不到，因为 Now 只剩待决策）→ 引导去任务看板
 * - 完全干净 → 鼓励文案 + 创建/历史入口
 */
export function NowEmptyGuide() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    Promise.all([
      api.listProjects().catch(() => []),
      api.listTasks().catch(() => []),
    ]).then(([projects, tasks]) => {
      const all = tasks as Array<{ status: string }>;
      setCounts({
        projects: projects.length,
        running: all.filter((t) => t.status?.startsWith("running_")).length,
        totalTasks: all.length,
      });
    });
  }, []);

  if (!counts) {
    return (
      <div className="mt-12 flex flex-col items-center text-muted-foreground">
        <p className="font-display text-lg">🎉 全部清空</p>
        <p className="mt-1 font-mono text-xs uppercase tracking-[0.12em]">
          没有需要关注的事
        </p>
      </div>
    );
  }

  // 场景 1：完全空（新用户）→ 引导建项目
  if (counts.projects === 0) {
    return (
      <Guide
        emoji="👋"
        title="欢迎使用 autopilot"
        sub="先建一个项目作为容器，然后才能开始任务"
        actions={[
          { to: "/library", icon: FolderPlus, label: "建第一个项目", primary: true },
        ]}
      />
    );
  }

  // 场景 2：有项目但没任务 → 引导开始任务
  if (counts.totalTasks === 0) {
    return (
      <Guide
        emoji="🚀"
        title="项目已就绪，开始你的第一个任务"
        sub="把需求扔给 AI，它会跑工作流（设计 → 评审 → 开发 → PR）"
        actions={[
          { to: "/start", icon: Sparkles, label: "从需求开始", primary: true },
          { to: "/workflows", icon: ListChecks, label: "先看工作流" },
        ]}
      />
    );
  }

  // 场景 3：有任务在跑（Now 看不到，因为 Now 只剩待决策）
  if (counts.running > 0) {
    return (
      <Guide
        emoji="⚙"
        title={`${counts.running} 个任务在跑`}
        sub="没有需要决策的事；去看板跟进任务进度"
        actions={[
          { to: "/tasks", icon: ListChecks, label: "看任务看板", primary: true },
          { to: "/start", icon: FilePlus, label: "再开一个" },
        ]}
      />
    );
  }

  // 场景 4：完全干净（项目和历史任务都有，但都跑完了）
  return (
    <Guide
      emoji={<CheckCircle2 className="h-10 w-10 text-success" />}
      title="全部清空"
      sub={`累计完成 ${counts.totalTasks} 个任务，没有待办`}
      actions={[
        { to: "/start", icon: FilePlus, label: "开始新任务", primary: true },
        { to: "/tasks", icon: ListChecks, label: "看历史" },
      ]}
    />
  );
}

interface Action {
  to: string;
  icon: typeof FilePlus;
  label: string;
  primary?: boolean;
}

function Guide({
  emoji,
  title,
  sub,
  actions,
}: {
  emoji: React.ReactNode;
  title: string;
  sub: string;
  actions: Action[];
}) {
  return (
    <Card className="mt-8 px-6 py-8 text-center">
      <div className="mb-3 flex justify-center text-3xl">{emoji}</div>
      <h2 className="font-display text-xl font-bold uppercase tracking-wider">{title}</h2>
      <p className="mt-2 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
        {sub}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {actions.map((a) => (
          <Link
            key={a.to + a.label}
            to={a.to}
            className={
              a.primary
                ? "inline-flex items-center gap-1.5 border-[1.5px] border-accent bg-accent px-3 py-1.5 font-mono text-xs uppercase tracking-[0.12em] text-accent-foreground transition-colors hover:bg-accent/85"
                : "inline-flex items-center gap-1.5 border-[1.5px] border-foreground/30 bg-card px-3 py-1.5 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            }
          >
            <a.icon className="h-3.5 w-3.5" />
            {a.label}
          </Link>
        ))}
      </div>
    </Card>
  );
}
