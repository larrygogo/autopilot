/**
 * 从一段完整的 workflow.ts 文本中切出某个 phase 函数的源码片段。
 *
 * 匹配以下任一形式：
 *   export async function <name>(...) { ... }
 *   export function <name>(...) { ... }
 *   export const <name> = async (...) => { ... }
 *   export const <name> = (...) => { ... }
 *
 * 用括号配对扫描函数体，避免被字符串字面量里的 } 误终止——保持简单：只在朴素扫描层
 * 跟踪 { } 计数，不解析字符串/正则字面量。够用，因为 workflow.ts 通常是脚手架代码。
 */
export function extractPhaseFunction(tsSource: string, phaseName: string): string | null {
  if (!tsSource || !phaseName) return null;

  // 尝试 function 声明
  const fnDeclRe = new RegExp(
    `(export\\s+(?:async\\s+)?function\\s+${escapeRegex(phaseName)}\\b[^{]*\\{)`,
  );
  const fnMatch = tsSource.match(fnDeclRe);
  if (fnMatch && fnMatch.index !== undefined) {
    return sliceFromOpenBrace(tsSource, fnMatch.index, fnMatch[0]);
  }

  // 尝试箭头函数赋值（export const xxx = ... => {...}）
  // 允许参数后带返回类型注解（: Promise<void> 等），用 lazy 量词扫到第一个 "=> {"
  const arrowRe = new RegExp(
    `(export\\s+(?:const|let)\\s+${escapeRegex(phaseName)}\\s*=[^;{]*?=>\\s*\\{)`,
  );
  const arrowMatch = tsSource.match(arrowRe);
  if (arrowMatch && arrowMatch.index !== undefined) {
    return sliceFromOpenBrace(tsSource, arrowMatch.index, arrowMatch[0]);
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceFromOpenBrace(src: string, start: number, header: string): string {
  // header 末尾的 { 是函数体的起始
  const bodyStart = start + header.length;
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) return src.slice(start); // 配对失败兜底
  return src.slice(start, i);
}
