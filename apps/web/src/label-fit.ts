/**
 * 黑板节点文字的排版预算必须和画布样式的 text-max-width 一致。
 * 之前按「22 个宽度单位」估算行数，实际 13px 中文每行只能放 8–9 个字，
 * 长标签因此比节点框高，文字从框底漏出去。这里按实际字宽逐字换行，
 * 并把放不下的部分截断，节点高度再据此计算。
 *
 * 抽成独立模块是因为「按测试域分框」也要用同一套字宽规则生成卡片里的
 * 紧凑标签；两处各写一份，迟早会再次出现文字溢出。
 */
export const NODE_LINE_HEIGHT = 16;
export const NODE_TEXT_PADDING = 18;
export const NODE_MIN_HEIGHT = 46;

export const glyphWidth = (char: string) => (char.codePointAt(0)! > 255 ? 13.2 : 7.4);

/** 按字符宽度换行；超过行数上限时截断并补省略号，保证文字不会溢出节点。 */
export function fitNodeLabel(text: string, maxWidth: number, maxLines: number) {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  let width = 0;
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === "\n") {
      lines.push(current);
      current = "";
      width = 0;
      index += 1;
      if (lines.length >= maxLines) break;
      continue;
    }
    const charWidth = glyphWidth(char);
    if (width + charWidth > maxWidth && current) {
      lines.push(current);
      current = "";
      width = 0;
      if (lines.length >= maxLines) break;
      continue;
    }
    current += char;
    width += charWidth;
    index += 1;
  }
  if (lines.length < maxLines && (current || !lines.length)) lines.push(current);

  const truncated = index < chars.length;
  if (truncated && lines.length) {
    const last = Array.from(lines[lines.length - 1]);
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, last.length - 1)).join("")}…`;
  }
  return { label: lines.join("\n"), lines: lines.length || 1 };
}
