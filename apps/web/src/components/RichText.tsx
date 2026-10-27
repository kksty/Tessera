import type { ReactNode } from "react";
import { prettyText } from "../text.js";

/** 只解析模型输出中常见的轻量 Markdown：标题、列表、引用、围栏代码与行内代码/加粗。
 *  不引入 HTML，也不把模型文本当作可执行标记。 */
type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 3 | 4; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "pre"; text: string }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] };

const inlinePattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

export function InlineText({ text }: { text: string }) {
  return (
    <>
      {text.split(inlinePattern).map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
          return <code key={index}>{part.slice(1, -1)}</code>;
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

const isFence = (line: string) => /^```/.test(line);
const isHeading = (line: string) => /^#{1,4}\s+/.test(line);
const isBullet = (line: string) => /^[-*•]\s+/.test(line);
const isOrdered = (line: string) => /^\d+[.)]\s+/.test(line);
const isQuote = (line: string) => /^>\s?/.test(line);
const isHr = (line: string) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim());
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string) => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
// 审核记录常用「一、二、」分节，单独识别能让长记录有清晰的段落层级。
const isChineseHeading = (line: string) => /^[一二三四五六七八九十百]+、/.test(line);
const isBlockStart = (line: string) =>
  isFence(line) ||
  isHeading(line) ||
  isHr(line) ||
  isTableRow(line) ||
  isChineseHeading(line) ||
  isBullet(line) ||
  isOrdered(line) ||
  isQuote(line);

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

function parseBlocks(source: string, preserveLines = false): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ kind: "pre", text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length <= 2 ? 3 : 4, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]) && !isTableSeparator(lines[index])) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (isChineseHeading(line)) {
      blocks.push({ kind: "h", level: 4, text: line.trim() });
      index += 1;
      continue;
    }

    if (isBullet(line)) {
      const items: string[] = [];
      while (index < lines.length && isBullet(lines[index])) {
        items.push(lines[index].replace(/^[-*•]\s+/, "").trim());
        index += 1;
        // 允许列表项下缩进续行，保留为同一项。
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !isBlockStart(lines[index].trim())) {
          items[items.length - 1] += `\n${lines[index].trim()}`;
          index += 1;
        }
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (isOrdered(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrdered(lines[index])) {
        items.push(lines[index].replace(/^\d+[.)]\s+/, "").trim());
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !isBlockStart(lines[index].trim())) {
          items[items.length - 1] += `\n${lines[index].trim()}`;
          index += 1;
        }
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (isQuote(line)) {
      const quote: string[] = [];
      while (index < lines.length && isQuote(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }

    const paragraph = [preserveLines ? line.replace(/\s+$/, "") : line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(preserveLines ? lines[index].replace(/\s+$/, "") : lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "p", text: paragraph.join("\n") });
  }

  return blocks;
}

function blockNode(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "p":
      return (
        <p key={index}>
          <InlineText text={block.text} />
        </p>
      );
    case "h": {
      const Heading = block.level === 3 ? "h3" : "h4";
      return (
        <Heading key={index}>
          <InlineText text={block.text} />
        </Heading>
      );
    }
    case "ul":
      return (
        <ul key={index}>
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineText text={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={index}>
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineText text={item} />
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote key={index}>
          {block.lines.map((line, i) => (
            <p key={i}>
              <InlineText text={line} />
            </p>
          ))}
        </blockquote>
      );
    case "pre":
      return (
        <pre key={index}>
          <code>{block.text}</code>
        </pre>
      );
    case "hr":
      return <hr key={index} />;
    case "table":
      return (
        <div className="rich-table-wrap" key={index}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>
                    <InlineText text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <InlineText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function RichText({
  text,
  className = "",
  preserveLines = false,
}: {
  text?: string | null;
  className?: string;
  /** 证据正文用：解析标题/列表，但不折叠普通段落里的换行与缩进。 */
  preserveLines?: boolean;
}) {
  const source = prettyText(text).trim();
  if (!source) return null;
  return (
    <div className={`rich-text ${preserveLines ? "rich-text-lines" : ""} ${className}`.trim()}>
      {parseBlocks(source, preserveLines).map(blockNode)}
    </div>
  );
}

/** 取第一段作为导语；返回剩余部分，避免“导语 + 完整记述”重复同一段。
 *  模型有时只用单换行分段：首行作为导语，其余交给富文本，避免整段挤成一面墙。 */
export function splitLead(text?: string | null): { lead: string; rest: string } {
  const source = prettyText(text).trim();
  if (!source) return { lead: "", rest: "" };
  const boundary = source.indexOf("\n\n");
  if (boundary >= 0) return { lead: source.slice(0, boundary).trim(), rest: source.slice(boundary + 2).trim() };
  const lines = source.split("\n");
  // 以标题、列表或代码开头的文本没有天然导语，整体交给富文本。
  if (/^(#{1,4}\s|[-*•]\s|\d+[.)]\s|>|```)/.test(lines[0])) return { lead: "", rest: source };
  if (lines.length > 3) return { lead: lines[0].trim(), rest: lines.slice(1).join("\n").trim() };
  return { lead: source, rest: "" };
}
