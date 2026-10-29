/**
 * Soft guard against a Step becoming a remote-control script.
 *
 * A Step is the question the executor must answer; method, parameters, command
 * lines and repetition counts belong to the executor. The schema cannot tell
 * prose apart, so this returns non-blocking warnings for the Decider instead of
 * rejecting the plan. High precision beats recall: a false warning trains the
 * model to ignore the signal.
 */
const METHOD_MARKERS: { label: string; pattern: RegExp }[] = [
  {
    label: "具体命令",
    pattern: /\b(curl|wget|nmap|sqlmap|ffuf|gobuster|dirb|nikto|hydra|nuclei|masscan|netcat)\b/i,
  },
  { label: "HTTP 方法 + 路径", pattern: /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:\/|https?:\/\/)\S*/ },
  { label: "带参数的 URL", pattern: /https?:\/\/\S+\?\S+/i },
  { label: "请求载荷", pattern: /(--data\b|-d\s+['"]|Content-Type:|Authorization:\s*Bearer)/i },
  { label: "重复次数", pattern: /(?:重复|跑|执行|发送)\s*\d{1,4}\s*(?:次|轮)/ },
  { label: "哈希清单", pattern: /\b[a-f0-9]{32,}\b/i },
];

/** Return zero or one warning for a Step description, never a rejection. */
export function stepIntentWarnings(stepId: string, description: string): string[] {
  const hits = METHOD_MARKERS.filter((marker) => marker.pattern.test(description)).map((marker) => marker.label);
  if (!hits.length) return [];
  return [
    `${stepId}: description 出现${hits.join("、")}；这是执行方法，不是要回答的问题。` +
      "把方法、参数和次数留给执行者，Step 只写问题、决策价值与可证伪的 property。",
  ];
}
