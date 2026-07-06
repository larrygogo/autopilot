#!/usr/bin/env bun
// 造一条「文件产物交付」演示需求 + 两轮交付，用于在 Web 验收卡里看新的按类型展示。
// 跑：bun run scripts/mock-delivery.ts   （写真实 ~/.autopilot DB；跑完打印需求 URL）
// 清：在 Web 需求页删除，或 bun run scripts/mock-delivery.ts --clean
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initDb, getDb, createTask } from "../src/core/db";
import { createProject } from "../src/core/projects";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createRequirement, nextRequirementId, deleteRequirement } from "../src/core/requirements";
import { deliverArtifacts } from "../src/core/requirements/deliveries";

initDb();
const db = getDb();

// --clean：删掉之前造的演示需求 + 项目
if (process.argv.includes("--clean")) {
  const rows = db.query<{ id: string }, []>("SELECT id FROM requirements WHERE title LIKE '【演示】%'").all();
  for (const r of rows) deleteRequirement(r.id);
  db.run("DELETE FROM workspaces WHERE id = 'ws-mockdlv'");
  db.run("DELETE FROM projects WHERE id = 'proj-mockdlv'");
  console.log(`已清理 ${rows.length} 条演示需求 + 演示项目。`);
  process.exit(0);
}

// 项目 / 代码库（幂等：存在就复用）
if (!db.query("SELECT 1 FROM projects WHERE id='proj-mockdlv'").get())
  createProject({ id: "proj-mockdlv", name: "产物展示演示" });
if (!db.query("SELECT 1 FROM workspaces WHERE id='ws-mockdlv'").get())
  createWorkspace({ id: "ws-mockdlv", project_id: "proj-mockdlv", alias: "demo", path: "/tmp/demo", default_branch: "main" });

const reqId = nextRequirementId();
createRequirement({ id: reqId, project_id: "proj-mockdlv", workspace_id: "ws-mockdlv", title: "【演示】落地页设计 + 可交互 demo" });
const taskId = `mockdlv${Date.now().toString(36)}`;
createTask({ id: taskId, title: "【演示】产物交付", workflow: "artifact", initialStatus: "running_produce", requirementId: reqId });

function srcDir(files: Record<string, string>): string {
  const dir = join(tmpdir(), `mockdlv-${Math.random().toString(36).slice(2, 8)}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return dir;
}

const HERO_V1 = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" fill="#F5F0E8"/>
  <circle cx="90" cy="90" r="48" fill="#9aa0a6"/>
  <rect x="160" y="64" width="120" height="14" rx="7" fill="#3a372f"/>
  <rect x="160" y="92" width="90" height="10" rx="5" fill="#bdb9b1"/>
</svg>`;
const HERO_V2 = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" fill="#F5F0E8"/>
  <circle cx="90" cy="90" r="52" fill="#D97757"/>
  <rect x="160" y="60" width="130" height="16" rx="8" fill="#3a372f"/>
  <rect x="160" y="90" width="100" height="11" rx="5" fill="#D97757"/>
  <rect x="160" y="112" width="70" height="11" rx="5" fill="#bdb9b1"/>
</svg>`;
const PALETTE = `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="60">
  <rect x="0" y="0" width="70" height="60" fill="#D97757"/><rect x="70" y="0" width="70" height="60" fill="#F5F0E8"/>
  <rect x="140" y="0" width="70" height="60" fill="#3a372f"/><rect x="210" y="0" width="70" height="60" fill="#26241f"/>
</svg>`;
const DEMO_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui;background:#F5F0E8;color:#3a372f;display:grid;place-items:center;height:100vh;margin:0}
button{background:#D97757;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:16px;cursor:pointer}
#n{font-size:40px;margin:16px}</style></head><body><div style="text-align:center">
<div id="n">0</div><button onclick="document.getElementById('n').textContent=++window.c||(window.c=1)">点我 +1</button>
<p style="color:#bdb9b1">可交互 demo（在隔离沙箱里运行）</p></div></body></html>`;
const README = `# 落地页设计说明\n\n本轮交付了**主视觉**与**可交互 demo**。\n\n## 文件\n- \`hero.svg\` — 主视觉横幅\n- \`palette.svg\` — 品牌配色\n- \`demo.html\` — 可点击计数 demo\n\n## 设计原则\n1. 暖象牙底 \`#F5F0E8\`\n2. 珊瑚橘强调 \`#D97757\`\n\n\`\`\`css\n.btn { background: #D97757; }\n\`\`\`\n`;
const TOKENS = JSON.stringify({ bg: "#F5F0E8", accent: "#D97757", ink: "#3a372f", radius: 10 }, null, 2);

// 第 1 轮（带文件夹结构：assets/ src/ docs/，演示文件树）
const dir1 = srcDir({
  "index.html": DEMO_HTML,
  "tokens.json": TOKENS,
  "assets/hero.svg": HERO_V1,
  "assets/palette.svg": PALETTE,
  "assets/icons/home.svg": PALETTE,
  "assets/icons/menu.svg": PALETTE,
  "src/components/Button.css": ".btn{background:#D97757;border-radius:10px}",
  "src/components/Card.css": ".card{background:#F5F0E8;border-radius:14px}",
  "src/demo.html": DEMO_HTML,
  "docs/README.md": README,
  "docs/CHANGELOG.md": "# 变更\n\n- v1 首版交付\n",
  "SUMMARY.md": "本轮交付落地页设计稿与可交互 demo（带 assets/ src/ docs/ 目录结构）：\n- `assets/hero.svg` 主视觉（点「预览」看）\n- `src/demo.html` 可交互 demo（点「打开」在隔离标签运行）\n\n已知限制：移动端断点未做。",
});
deliverArtifacts(taskId, dir1, "本轮交付落地页设计稿与可交互 demo（带 assets/ src/ docs/ 目录结构）。已知限制：移动端断点未做。");

// 第 2 轮（模拟驳回重交：配色改用品牌橘 + 加移动端）
const dir2 = srcDir({
  "index.html": DEMO_HTML,
  "tokens.json": TOKENS,
  "assets/hero.svg": HERO_V2,
  "assets/mobile.svg": PALETTE,
  "docs/README.md": README,
  "SUMMARY.md": "按上轮意见「配色太灰、主视觉不够突出」重做：主视觉改用品牌橘 #D97757，补 assets/mobile.svg 移动端稿。",
});
deliverArtifacts(taskId, dir2, "按上轮意见「配色太灰」重做：主视觉改用品牌橘，补移动端稿。");

// 直接置 awaiting_review（演示用，跳过状态机；要 task_id 指向才进验收上下文）
db.run("UPDATE requirements SET status='awaiting_review', task_id=? WHERE id=?", [taskId, reqId]);
// task 必须置终态（done）：否则留在 running_produce，daemon 启动会把它当「卡死任务」恢复执行，
// 执行这个畸形假 task（无真实 sandbox）的过程会清掉本脚本造的演示 deliveries（DB 表记录却留着，
// 造成「有记录无文件」）。终态 task 不被 watcher 恢复，演示数据才稳定。
db.run("UPDATE tasks SET status='done' WHERE id=?", [taskId]);

console.log(`\n✅ 演示需求已创建：${reqId}（2 轮交付）`);
console.log(`   打开（硬刷新看新验收卡）：http://127.0.0.1:6180/requirements/${reqId}`);
console.log(`   清理：bun run scripts/mock-delivery.ts --clean\n`);
process.exit(0);
