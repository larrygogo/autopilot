/**
 * LLM JSON 输出宽松解析。
 *
 * 即使 system prompt 写「不要 ```json 围栏」，模型也常常无视：
 *   - 包 markdown code fence（```json ... ```）
 *   - 前缀加说明文字（"好的，下面是 JSON："）
 *   - 尾部多个 `.` 或换行
 *
 * 直接 `JSON.parse(raw)` 必挂。这里做轻量清洗：
 *   1. trim 后剥掉外层 ```json``` / ``` ``` 围栏
 *   2. 直接 parse；失败则
 *   3. 取第一个 `{` 到最后一个 `}` 的子串再 parse（兜住前后有自然语言的情况）
 *
 * 数组返回的 LLM 同理可扩展为 `[ ... ]` 兜底，目前 autopilot 内的用例都是
 * 对象返回，先只覆盖 `{}`。
 */

/**
 * 把 LLM 返回的原始字符串解析为 JSON。
 * 失败时抛 SyntaxError（带原文前 200 字符方便排查）。
 */
export function parseLooseJson<T = unknown>(raw: string): T {
  let s = raw.trim();

  // 1) 剥外层 markdown code fence（兼容 ```json / ```JSON / 纯 ``` 三种）
  const fence = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) s = fence[1]!.trim();

  // 2) 直接 parse
  try {
    return JSON.parse(s) as T;
  } catch { /* fall through to brace extraction */ }

  // 3) 取首个 `{` 到末个 `}` 的子串
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = s.slice(first, last + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch { /* fall through to throw */ }
  }

  throw new SyntaxError(
    `无法从 LLM 输出解析 JSON：${raw.slice(0, 200)}${raw.length > 200 ? "..." : ""}`,
  );
}
