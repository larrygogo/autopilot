// 三叶结 logo 生成器：参数方程画出几何精修的闭合三叶结，
// 数值检测三个自交点，按编织规则给每个 passage 标过/穿（under 端留缺口），
// 输出珊瑚橘/炭灰双色 + 珊瑚单色两版 SVG，外加明暗对照画廊。
// 运行：bun design/logo/gen.ts

const CORAL = "#D97757"; // 品牌 accent ≈ oklch(0.64 0.13 42)
const CHARCOAL = "#3A3733"; // 暖炭灰

type Pt = { x: number; y: number };

const N = 720;
const TWO_PI = Math.PI * 2;

// 标准 (2,3) 环面结的 2D 投影：三个交叉点、三重对称
function curvePoint(t: number): Pt {
  return {
    x: Math.sin(t) + 2 * Math.sin(2 * t),
    y: Math.cos(t) - 2 * Math.cos(2 * t),
  };
}

const ROT = (Number(process.env.ROT ?? "0") * Math.PI) / 180;
function rot(p: Pt): Pt {
  return { x: p.x * Math.cos(ROT) - p.y * Math.sin(ROT), y: p.x * Math.sin(ROT) + p.y * Math.cos(ROT) };
}
const pts: Pt[] = [];
for (let i = 0; i < N; i++) pts.push(rot(curvePoint((i / N) * TWO_PI)));

// 线段相交
function segInt(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const ua = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const ub = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (ua < 0 || ua > 1 || ub < 0 || ub > 1) return null;
  return { x: p1.x + ua * (p2.x - p1.x), y: p1.y + ua * (p2.y - p1.y) };
}

// 检测自交：返回交叉点（每个含两个 passage 的 segment 起点索引）
type Crossing = { a: number; b: number; pt: Pt };
const crossings: Crossing[] = [];
for (let i = 0; i < N; i++) {
  for (let j = i + 2; j < N; j++) {
    if (i === 0 && j === N - 1) continue; // 收尾相邻段
    const p = segInt(pts[i], pts[(i + 1) % N], pts[j], pts[(j + 1) % N]);
    if (p) crossings.push({ a: i, b: j, pt: p });
  }
}
// 去重（数值上同一交叉可能被相邻段重复捕获）—— 按距离聚类
const uniq: Crossing[] = [];
for (const c of crossings) {
  if (!uniq.some((u) => Math.hypot(u.pt.x - c.pt.x, u.pt.y - c.pt.y) < 0.2)) uniq.push(c);
}
console.log("检测到交叉点：", uniq.length);
if (uniq.length !== 3) console.warn("⚠ 期望 3 个交叉点");

// 6 个 passage 索引（升序），记录每个 passage 属于哪个交叉
const passages: { idx: number; crossing: number }[] = [];
uniq.forEach((c, ci) => {
  passages.push({ idx: c.a, crossing: ci });
  passages.push({ idx: c.b, crossing: ci });
});
passages.sort((p, q) => p.idx - q.idx);

// 按排序奇偶交替分配 over/under —— 对标准三叶结，每个交叉恰好一过一穿
const over = new Map<number, boolean>(); // passage.idx -> isOver
passages.forEach((p, rank) => over.set(p.idx, rank % 2 === 0));
// 校验：每个交叉一过一穿
for (let ci = 0; ci < uniq.length; ci++) {
  const ps = passages.filter((p) => p.crossing === ci);
  const overs = ps.filter((p) => over.get(p.idx)).length;
  if (overs !== 1) {
    // 退化兜底：靠前的 passage 设为 over
    ps.sort((a, b) => a.idx - b.idx);
    over.set(ps[0].idx, true);
    over.set(ps[1].idx, false);
  }
}

// 归一化到 viewBox
const VB = 100;
const PAD = 14;
const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);
const span = Math.max(maxX - minX, maxY - minY);
const scale = (VB - 2 * PAD) / span;
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
function tx(p: Pt): Pt {
  return { x: VB / 2 + (p.x - cx) * scale, y: VB / 2 + (p.y - cy) * scale };
}
const P = pts.map(tx);

const STROKE = 11; // 线宽（viewBox 单位）
const GAP = STROKE * (Number(process.env.GAP ?? "1.7")); // under 端缺口（每侧弧长）—— 定稿值

function chord(i: number, j: number) {
  return Math.hypot(P[j].x - P[i].x, P[j].y - P[i].y);
}

// 从 passage start 到 end（索引，可跨 0）取一段，按需在 under 端裁掉缺口
function buildArc(startIdx: number, endIdx: number): Pt[] {
  const out: Pt[] = [];
  let i = startIdx;
  while (true) {
    out.push(P[i]);
    if (i === endIdx) break;
    i = (i + 1) % N;
  }
  // 起点端缺口
  if (!over.get(startIdx)) {
    let acc = 0;
    while (out.length > 2) {
      acc += Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y);
      out.shift();
      if (acc >= GAP) break;
    }
  }
  // 终点端缺口
  if (!over.get(endIdx)) {
    let acc = 0;
    while (out.length > 2) {
      const n = out.length;
      acc += Math.hypot(out[n - 1].x - out[n - 2].x, out[n - 1].y - out[n - 2].y);
      out.pop();
      if (acc >= GAP) break;
    }
  }
  return out;
}

function polyToPath(arc: Pt[]): string {
  return arc.map((p, k) => `${k === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

// 定稿：闭合三叶结，珊瑚单色。6 段弧首尾相接成闭环，three 处 under 穿越按 GAP 留缺口形成编织。
const passIdx = passages.map((p) => p.idx);
const arcPaths: string[] = [];
for (let k = 0; k < passIdx.length; k++) {
  const s = passIdx[k];
  const e = passIdx[(k + 1) % passIdx.length];
  arcPaths.push(polyToPath(buildArc(s, e)));
}

// stroke 用 currentColor，便于明暗主题随文字色翻转；默认色给珊瑚橘兜底
const body = arcPaths
  .map((d) => `  <path d="${d}" fill="none" stroke="${CORAL}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`)
  .join("\n");
const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${VB}" height="${VB}" role="img" aria-label="autopilot">
${body}
</svg>
`;
// currentColor 版（接入 Web UI 用，随主题变色）
const svgCurrent = svgStr.replace(new RegExp(CORAL, "g"), "currentColor");

const fs = await import("node:fs");
const dir = import.meta.dir;
fs.writeFileSync(`${dir}/autopilot-logo.svg`, svgStr);
fs.writeFileSync(`${dir}/autopilot-logo-currentcolor.svg`, svgCurrent);
console.log("已生成定稿 autopilot-logo.svg（珊瑚橘）+ autopilot-logo-currentcolor.svg（随主题）");
