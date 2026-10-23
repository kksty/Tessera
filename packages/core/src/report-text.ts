const newlines = (text: string) => text.replace(/\r\n?/g, "\n");

/** Plain prose: blank lines separate paragraphs; soft line breaks become spaces. */
export function prose(text: string): string {
  return newlines(text).split(/\n[\t ]*\n/)
    .map(block => block.split("\n").map(line => line.trim()).join(" ").trim())
    .filter(Boolean).join("\n\n");
}

function escape(text: string): string {
  // Escape backslashes first, and ampersands before a renderer can decode entities.
  return text.replace(/&/g, "&amp;").replace(/[\\`*_[\]{}()<>#!|~]/g, "\\$&");
}

export const inline = (text: string): string => escape(newlines(text).replace(/\n/g, " ").trim());
export const paragraph = (text: string): string => prose(text).split("\n\n")
  .map(block => escape(block).replace(/^([+\-=])(?=\s|[+\-=]|$)/, "\\$1")
    .replace(/^(\d{1,9})\.(?=\s|$)/, "$1\\."))
  .join("\n\n");

/** Raw evidence is literal, including trailing blank lines and embedded fences. */
export function fence(text: string, lang = "text"): string {
  if (!/^[a-zA-Z0-9_-]*$/.test(lang)) throw new Error("Invalid code fence language");
  let length = 3;
  for (const run of text.matchAll(/`{3,}/g)) length = Math.max(length, run[0].length + 1);
  const mark = "`".repeat(length), body = newlines(text);
  return `${mark}${lang}\n${body}${body.endsWith("\n") ? "" : "\n"}${mark}`;
}

export type ReproBlock = { kind: "request" | "step"; text: string };
const requestStart = /^(?:curl\b|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+(?:https?:\/\/|\/))/i;
const requestLine = /^(?:body|headers?|cookie|authorization|content-type|accept|user-agent|host|origin|referer|x-[\w-]+)\s*:/i;
const curlFlag = /^(?:-[A-Za-z]|--[a-z][\w-]*)\b/;
const stripStepNumber = (text: string) => newlines(text).replace(/^\s*(?:\d{1,9}[.)、]|步骤\s*\d+\s*[:：]?)\s*/, "").trim();

/** Keep a request and separately recorded headers/body together in both renderers. */
export function reproductionBlocks(steps: string[]): ReproBlock[] {
  const blocks: ReproBlock[] = [];
  for (let index = 0; index < steps.length; index++) {
    const text = stripStepNumber(steps[index]);
    if (!text) continue;
    if (!requestStart.test(text)) {
      blocks.push({ kind: "step", text: prose(text) });
      continue;
    }
    const lines = [text];
    while (index + 1 < steps.length) {
      const next = stripStepNumber(steps[index + 1]);
      if (!requestLine.test(next) && !curlFlag.test(next)) break;
      lines.push(next);
      index++;
    }
    blocks.push({ kind: "request", text: lines.join("\n") });
  }
  return blocks;
}
