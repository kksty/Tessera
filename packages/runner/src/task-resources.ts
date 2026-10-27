import { readFile } from "node:fs/promises";
import { DefaultResourceLoader, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { outputLanguage } from "./prompts.js";

export const fallbackEnvironment =
  "The environment provides Linux security tools and Python. /workspace is the durable project directory.";

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
  const prompts = taskSystemPrompts(await readFile(environmentPath, "utf8").catch(() => fallbackEnvironment));
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
