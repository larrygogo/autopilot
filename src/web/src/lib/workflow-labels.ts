/**
 * 工作流阶段显示名工具。
 *
 * 唯一显示名来源：工作流 spec 里的 `label:` 字段。所有 UI 渲染阶段名都
 * 应通过 pickPhaseLabel 取值，避免节点 / drawer / 标题等显示不一致。
 *
 * registry 在 expandPhaseDefaults 会把缺省 label 兜底填成 name.toUpperCase()，
 * 那不是用户真填的——userPhaseLabel 会识别并返回 undefined，让显示落回 name。
 */

export function pickPhaseLabel(item: { name: string; label?: string | null }): string {
  return userPhaseLabel(item) ?? item.name;
}

export function userPhaseLabel(item: { name: string; label?: string | null }): string | undefined {
  if (typeof item.label !== "string" || item.label === "") return undefined;
  if (item.label === item.name.toUpperCase()) return undefined;
  return item.label;
}
