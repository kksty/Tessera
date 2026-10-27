/** 证据正文的 Markdown 判定：
 *  - 显式标记（`text/markdown` MIME 或 `.md` 来源）直接按文档渲染；
 *  - 大模型也常把 Markdown 写进 `.txt`、进程日志甚至 octet-stream，因此再按正文识别文档：
 *    至少两级标题（如 `#` + `##`）、至少两处标题且有空行分段（与只有 `#` 注释的字典、脚本区分）；
 *  - 原始 HTTP 报文、JSON、HTML、脚本和只有一级 `#` 注释的日志不猜格式，保持原文。
 *  读者仍可在证据页手动切换渲染。 */
export type EvidenceLike = { mime_type?: string | null; source_path?: string | null };

const MARKDOWN_MIME = /^text\/(?:x-)?markdown\b/i;
const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/i;

const SAMPLE_CHARS = 20_000;
const SAMPLE_LINES = 600;
const HEADING = /^(#{1,4})[ \t]+\S/;
const FENCE = /^[ \t]*(?:```|~~~)/;
/** 这些开头是原件而不是文档：脚本、JSON、HTML 与 HTTP 报文。 */
const RAW_START =
  /^(?:HTTP\/\d|(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE|CONNECT)\s+\S+\s+HTTP\/\d|<!doctype\s|<\?xml\s|<html[\s>]|#![ \t]*\/|\{|\[)/i;

/** 把 Markdown 写进 .txt / 日志时常见「一级标题 + 二级分节 + 空行」的骨架；
 *  只有 `#` 注释（字典、清单、subdomain 摘要）没有二级标题，不会被误判。 */
export function looksLikeMarkdownDocument(text: string): boolean {
  const head = text.slice(0, SAMPLE_CHARS).replace(/\r\n?/g, "\n");
  if (!head.trim() || RAW_START.test(head.trimStart())) return false;
  let fenced = false;
  let blanks = 0;
  let headings = 0;
  const levels = new Set<number>();
  for (const line of head.split("\n", SAMPLE_LINES)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line.trim()) {
      blanks += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      headings += 1;
      levels.add(heading[1].length);
    }
  }
  return headings >= 2 && levels.size >= 2 && blanks >= 1;
}

/** 默认视图是否为 Markdown：显式标记优先，其次才看正文结构。 */
export function isMarkdownEvidence(meta: EvidenceLike, text = ""): boolean {
  return (
    MARKDOWN_MIME.test((meta.mime_type || "").trim()) ||
    MARKDOWN_PATH.test(meta.source_path || "") ||
    looksLikeMarkdownDocument(text)
  );
}
