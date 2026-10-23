// Deterministic local integration fixture. No target or paid provider requests.
import Fastify from "fastify";
const app = Fastify();
function viewFrom(text) {
  const marker = "当前视图：";
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("Missing current graph projection");
  return JSON.parse(text.slice(start + marker.length).trimStart().split(String.fromCharCode(10))[0]);
}
app.get("/v1/models", () => ({ data: [{ id: "tessera-fixture", context_window: 32000 }] }));
app.post("/v1/chat/completions", async (req, reply) => {
  const messages = req.body.messages;
  const text = messages.filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : message.content?.map(part => part.text || "").join(""))
    .join(String.fromCharCode(10));
  const view = viewFrom(text);
  const lastTool = messages.filter(message => message.role === "tool").at(-1);
  let payload, call;
  if (view.finding?.id) {
    if (!lastTool) call = { id: "call_review", name: "read_evidence", arguments: { id: view.finding.evidence_ids[0] } };
    else {
      const negative = view.goal.includes("negative");
      const informational = view.goal.includes("informational");
      if (negative || view.goal.includes("late")) await new Promise(resolve => setTimeout(resolve, 3500));
      payload = {
        kind: informational ? "informational" : "vulnerability",
        verdict: negative ? "needs_evidence" : "pass", reason: "已读取合成原始证据，核对测试标记",
        evidence_ids: view.finding.evidence_ids,
        ...(view.goal.includes("autonomous deletion") ? { planning_issues: ["合成验收：审核结束后决定是否删除此分支"] } : {}),
        ...(negative ? { verification: "合成缺口，交给 Decide 决定是否继续" } : informational ? {} : {
          cvss: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N", rationale: "合成评分仅用于验证审核链路",
            impact_evidence: [{ metric: "VC", affected: "合成测试资源", boundary: "测试约定的受保护资源边界",
              consequence: "合成证据记录边界验证结果，仅用于验证协议", evidence_ids: view.finding.evidence_ids }] },
        }),
      };
    }
  } else if (view.focus?.id) {
    if (!lastTool) call = { id: "call_bash", name: "bash", arguments: { command: "printf 'fixture proof' > /workspace/qa-proof.txt" } };
    else if (lastTool.tool_call_id === "call_bash") call = {
      id: "call_save", name: "save_evidence", arguments: { path: "qa-proof.txt", title: "合成原始证据", mime_type: "text/plain" },
    };
    else {
      const content = typeof lastTool.content === "string" ? lastTool.content : lastTool.content.map(part => part.text || "").join("");
      const evidence = JSON.parse(content);
      payload = {
        facts: [{ description: "已保存合成测试标记", conclusion: "合成证据保存成功", status: "observed", evidence_ids: [evidence.id] }],
        findings: [{ title: "合成链路发现", description: "仅用于验证集成流程，不代表真实漏洞", evidence_ids: [evidence.id],
          impact: "合成测试记录了受保护测试标记的读取结果。",
          reproduction: { conditions: ["使用本地合成测试环境"], steps: ["运行标记命令并读取保存的 qa-proof.txt"], expected: "测试标记不可被未授权读取", observed: "合成证据包含测试标记" },
          remediation: "在合成测试资源的读取入口校验访问权限。" }],
        summary: "合成执行与证据归档完成",
      };
    }
  } else if (view.goal.includes("autonomous deletion") && view.findings?.length) {
    if (lastTool?.tool_call_id === "call_delete") payload = {};
    else if (lastTool?.tool_call_id === "call_preview_delete") call = {
      id: "call_delete", name: "submit_decisions", arguments: {
        delete_nodes: [{ id: "s001", reason: "合成验收：明确放弃此分支及其产出", cascade: "downstream" }],
        complete: { from: ["origin"], description: "合成删除与历史保留验收完成" },
      },
    };
    else if (view.findings.some(line => line.includes(" confirmed "))) call = {
      id: "call_preview_delete", name: "preview_deletions", arguments: {
        delete_nodes: [{ id: "s001", reason: "合成验收：明确放弃此分支及其产出", cascade: "downstream" }],
      },
    };
    else payload = {};
  } else if (view.findings?.length) {
    const closes = view.steps.filter(line => line.includes(" executed ")).map(line => ({
      id: line.split(" ")[0], expected_version: Number(/ v(\d+)/.exec(line)[1]), reason: "合成问题已有答案", evidence_ids: view.evidence.referenced_ids,
    }));
    payload = view.steps.some(line => !line.includes(" executed ")) ? {} : {
      closes, complete: { from: ["f001"], description: "合成链路完成；负面审核已考虑，不继续探索" },
    };
  } else payload = view.steps.length ? {} : {
    steps: [{ from: ["origin"], description: "运行本地无害标记并保存证据" }],
  };
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream" });
  const separator = String.fromCharCode(10, 10);
  const send = (delta, finish_reason = null) => reply.raw.write("data: " + JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "tessera-fixture",
    choices: [{ index: 0, delta, finish_reason }],
  }) + separator);
  if (call) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: JSON.stringify(payload) });
    send({}, "stop");
  }
  reply.raw.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + separator + "data: [DONE]" + separator);
  reply.raw.end();
});
await app.listen({ host: "0.0.0.0", port: 9000 });
