/** 模型有时把换行写成字面量 `\n`（或 `\t`），直接渲染会挤成一整段。
 *  展示前在客户端还原一次；只影响显示，不写回图数据。 */
export function prettyText(value?: string | null): string {
  return (value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ");
}
