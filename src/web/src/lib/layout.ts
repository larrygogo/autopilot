// 页面内容区宽度标准（三档，新页面必须从这里取，不要手写 max-w-*）。
// 动机：曾经 7xl/6xl/5xl/4xl/2xl + 三种 padding 并存，切页面内容区跳动。
//
//   PAGE_W       内容/列表/详情页（流水线、项目、工作流、需求/任务详情、库）
//   PAGE_W_FORM  设置与表单页（设置分区、提供商、AI 建工作流）—— 窄列保证表单可读
//   PAGE_W_FOCUS 向导/聚焦流（Setup、Start）—— 单任务居中
export const PAGE_W = "mx-auto w-full max-w-6xl px-5 py-6";
export const PAGE_W_FORM = "mx-auto w-full max-w-4xl px-5 py-6";
export const PAGE_W_FOCUS = "mx-auto w-full max-w-2xl px-5 py-8";
