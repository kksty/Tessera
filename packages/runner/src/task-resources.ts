import { readFile } from "node:fs/promises";
import { DefaultResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { outputLanguage } from "./prompts.js";

export const fallbackEnvironment =
  "The environment provides Linux security tools and Python. /workspace is the durable project directory.";

export function callbackEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.TESSERA_CALLBACK_HOST,
    first = Number(env.TESSERA_CALLBACK_PORT_START),
    last = Number(env.TESSERA_CALLBACK_PORT_END);
  if (
    !host ||
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 65535 ||
    first > last
  )
    return "";
  return `\n\n本项目回连地址：${host}；可用 TCP/UDP 端口：${first}–${last}。公网端口与本地监听端口一致。需要接收连接时，在此范围内选择未占用端口，绑定 0.0.0.0；让已授权目标连接 ${host}:所选端口。平台已经配置转发，无需修改网络、路由或容器。监听进程的生命周期由当前任务管理。`;
}

/** The only source of business system instructions, shared by runs and exports. */
export function taskSystemPrompts(environment: string) {
  return {
    systemPrompt: `你为 Tessera 完成当前安全测试任务：只对已批准资产发起主动测试，发现未批准的域名或 IP 用 discover_assets 登记，不直接请求。\n\n${outputLanguage}`,
    appendSystemPrompt: [environment.trim() || fallbackEnvironment],
  };
}

export async function taskResources(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  environmentPath = "/opt/tessera/environment.md",
) {
  const prompts = taskSystemPrompts(
    (await readFile(environmentPath, "utf8").catch(() => fallbackEnvironment)) + callbackEnvironment(),
  );
  // The project workspace is untrusted task data. Pi would otherwise auto-load
  // skills, extensions, prompt templates and themes from <cwd>/.pi (and ancestor
  // .agents/skills), which can inject instructions or execute code inside the Run.
  // Tessera supplies its own task system prompt and loads none of them.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    ...prompts,
  });
  await loader.reload();
  // Check the loaded boundary as well as its configuration (including after SDK upgrades).
  if (
    loader.getAgentsFiles().agentsFiles.length ||
    loader.getSkills().skills.length ||
    loader.getExtensions().extensions.length ||
    loader.getPrompts().prompts.length ||
    loader.getThemes().themes.length ||
    loader.getSystemPrompt() !== prompts.systemPrompt ||
    JSON.stringify(loader.getAppendSystemPrompt()) !== JSON.stringify(prompts.appendSystemPrompt)
  )
    throw new Error("Unexpected automatic Pi resources in Tessera task");
  return { loader, environment: prompts.appendSystemPrompt[0] };
}
