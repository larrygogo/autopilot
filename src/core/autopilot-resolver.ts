/**
 * @autopilot/* 别名解析器
 *
 * 让用户工作流（位于 AUTOPILOT_HOME/workflows/<name>/workflow.ts）可以用
 * 稳定的别名 import 框架代码，无需关心相对路径深度：
 *
 * ```ts
 * import { getTask } from "@autopilot/core/db";
 * import { getAgent } from "@autopilot/agents/registry";
 * ```
 *
 * 这样 examples 目录下的工作流可以原封不动 `cp -r` 到
 * `~/.autopilot/workflows/`，daemon 也能正确加载。
 *
 * 实现：注册 Bun.plugin 的 onResolve 钩子，把 `@autopilot/<rest>`
 * 重写为 `<autopilot-src>/<rest>`，其中 <autopilot-src> 由当前模块
 * （位于 src/core/autopilot-resolver.ts）的 `import.meta.dir` 往上一级
 * 得到，即 autopilot 仓库的 `src/` 绝对路径。这样无论 autopilot 部署
 * 在何处、用户工作流位于何处，别名都能解析到正确的源文件。
 *
 * 限制：
 *  - Bun.plugin 仅在当前 Bun 进程生效；fork 出的子进程需自行调用一次
 *    （见 bin/run-phase.ts）。
 *  - 仅在 Bun 运行时下生效；纯 tsc 类型检查依赖 tsconfig.json 的
 *    paths 字段（已配置 "@autopilot/*": ["src/*"]）。
 */

import { resolve, dirname } from "path";
import { existsSync } from "fs";

let installed = false;

const CANDIDATE_EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx", "/index.ts", "/index.js"];

function resolveWithExt(base: string): string {
  if (existsSync(base)) return base;
  for (const ext of CANDIDATE_EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  // 找不到时返回原 base 让 Bun 报清晰的 "Cannot find module"
  return base;
}

export function installAutopilotResolver(): void {
  if (installed) return;
  installed = true;

  // src/core/autopilot-resolver.ts → src/core → src
  const autopilotSrc = dirname(import.meta.dir);

  Bun.plugin({
    name: "autopilot-alias",
    setup(build) {
      build.onResolve({ filter: /^@autopilot\// }, (args) => {
        const rest = args.path.slice("@autopilot/".length);
        const base = resolve(autopilotSrc, rest);
        return { path: resolveWithExt(base) };
      });
    },
  });
}

/**
 * 兜底：直接返回 autopilot src 绝对路径，给 registry.ts 的 sed 预处理用。
 * Bun.plugin 在 dynamic import 后续的静态 import 链上不一定生效，所以
 * loadYamlWorkflow 加载 workflow.ts 前会读文件、把 `@autopilot/...` 替换
 * 成绝对路径再 import，确保用户工作流 cp 到任意位置都能跑。
 */
export function getAutopilotSrcPath(): string {
  return dirname(import.meta.dir);
}
