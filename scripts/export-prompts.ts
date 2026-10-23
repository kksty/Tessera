import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { promptFor, resultRepairPrompt } from '../packages/runner/src/prompts.js';
import { createAgentSession, SessionManager, createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';
import { taskResources } from '../packages/runner/src/task-resources.js';
import { configuredModel, modelSettings } from '../packages/models/src/runtime.js';
import { processTools } from '../packages/runner/src/process-sessions.js';
import { queryReferences, readReference } from '../packages/runner/src/references.js';

const source=readFileSync('packages/runner/src/run.ts','utf8');
const ast=ts.createSourceFile('run.ts',source,ts.ScriptTarget.Latest,true);
const variables=new Map<string,ts.Expression>();
function walk(node:ts.Node,fn:(node:ts.Node)=>void){fn(node);node.forEachChild(child=>walk(child,fn));}
walk(ast,node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)variables.set(node.name.text,node.initializer);});
const literal=(node:ts.Node)=>ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)?node.text:node.getText(ast);
// Build the actual SDK system message without a model request or global credentials.
const { runtime: modelRuntime, model } = await configuredModel({ id: 'prompt-export', provider: 'custom',
 base_url: 'http://prompt-export.invalid/v1', api_key: '', api: 'openai-completions', context_window: 128000 });
const settings = modelSettings(model);
const { loader } = await taskResources('/workspace', '/workspace/runs/prompt-export', settings, 'docker/tools/environment.md');
const { session } = await createAgentSession({ cwd: '/workspace', agentDir: '/workspace/runs/prompt-export',
 modelRuntime, model, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(), tools: [] });
const system = session.systemPrompt;
session.dispose();
let report='# 运行时提示词快照\n\n生成于 '+new Date().toISOString()+'。从当前源码与已安装 SDK 按需导出；项目视图、任务 ID 与证据使用占位，不包含运行配置或密钥。\n\n';
const section=(name:string,text:string,lang='text')=>{report+='## '+name+'\n\n```'+lang+'\n'+text+'\n```\n\n';};
report+='注入顺序：系统提示词、环境说明 → 当前图投影与任务提示词 → 按运行状态追加收尾、恢复或修复提示词。工具声明单独发送；不加载 skills 或固定专家身份。\n\n';
section('1. 完整系统提示词',system);
section('2. 完整初始 Work / Execute 提示词',promptFor({kind:'execute',step_id:'<当前 Step ID>'} as any,{动态占位:'此处由 memoryEntry 注入当前项目有界视图、计数、焦点和变化索引，内容因 Run 而异'},{} as any)+literal(variables.get('finalInstruction')!));
section('3. 收尾提示词',literal(variables.get('closeoutPrompt')!));
report+='收尾通过 session.steer 追加，前面会带触发原因。例如时间预算到期、压缩失败或执行权限在等待期间变化；具体触发受当前运行状态控制。\n\n';
let control=0;
walk(ast,node=>{
 if(!ts.isCallExpression(node)||node.expression.getText(ast)!=='session.prompt')return;
 walk(node.arguments[0],part=>{if(ts.isStringLiteral(part)&&part.text.length>60)section('4.'+(++control)+' 条件触发：恢复 / 最终序列化',part.text);});
});
section('5. JSON 修复提示词（含完整 Execute JSON Schema）',resultRepairPrompt({kind:'execute'} as any,'<本次实际校验错误，已脱敏并限制长度>'));
report+='## 6. 工具声明\n\n以下描述也是模型可见输入。参数展示源码构造式；运行时将其转换为对应 JSON Schema。普通 Execute 的 bash 使用 ProcessSessions 版本；只读恢复不启动新的进程管理器。\n\n';
walk(ast,node=>{
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==='tool'&&node.arguments.length>=3&&ts.isStringLiteral(node.arguments[0])){
 section('6. '+node.arguments[0].text,literal(node.arguments[1])+'\n\n参数定义：\n'+node.arguments[2].getText(ast));
 }
 if(ts.isObjectLiteralExpression(node)){
 const props=new Map(node.properties.filter(ts.isPropertyAssignment).map(prop=>[prop.name.getText(ast),prop.initializer]));
 if(props.get('name')&&ts.isStringLiteral(props.get('name')!)&&props.get('description')&&props.get('parameters'))section('6. '+literal(props.get('name')!),literal(props.get('description')!)+'\n\n参数定义：\n'+props.get('parameters')!.getText(ast));
 }
});
for(const tool of [createBashTool('/workspace'),createReadTool('/workspace'),createWriteTool('/workspace'),createEditTool('/workspace'),createGrepTool('/workspace'),createFindTool('/workspace'),createLsTool('/workspace'),...processTools({} as any)])section('6. '+tool.name+'（运行时工具声明）',JSON.stringify({name:tool.name,description:tool.description,parameters:tool.parameters},null,2),'json');
report+='## 7. SDK 上下文压缩提示词\n\nExecute 启用自动压缩时，SDK 会发起独立摘要调用。以下为当前安装 SDK 的原文，不是每一轮 Work 都会收到。实际待压缩对话、已有摘要和前缀内容动态填入。\n\n';
for(const file of ['utils.js','compaction.js']){
 const path='node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/'+file;
 const text=readFileSync(path,'utf8');const parsed=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const constants=new Map<string,ts.Expression>();
 walk(parsed,node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)constants.set(node.name.text,node.initializer);});
 function render(node:ts.Expression):string {
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  if(ts.isIdentifier(node)&&constants.has(node.text))return render(constants.get(node.text)!);
  if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(span=>render(span.expression)+span.literal.text).join('');
  return node.getText(parsed);
 }
 walk(parsed,node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&/SUMMARIZATION_(SYSTEM_PROMPT|PROMPT|INSTRUCTIONS)$/.test(node.name.text)&&node.initializer)section('7. '+node.name.text,render(node.initializer));});
}
report+='压缩调用外层：<conversation>动态对话</conversation>，有旧摘要时再附 <previous-summary>动态旧摘要</previous-summary>；前缀压缩以 # Conversation 和 # Instructions 组织。\n\n';
report+='## 8. 按需资料\n\nWorker 工具、字典与代理参考为 /opt/tessera/tools/reference.md，正文不默认注入。以下是图导航工具提供的只读参考。\n\n';

const refs=queryReferences() as any;
for(const ref of refs.items??refs.references??refs.records??(Array.isArray(refs)?refs:[])){
 let offset=0,content='';while(true){const page=readReference(ref.id,offset,4000);content+=page.content;if(page.next_offset===null)break;offset=page.next_offset;}section('8. 内置只读参考 '+ref.id,content);
}
report+='工具参考按需读取；noExtensions、noSkills、noPromptTemplates、noContextFiles 禁止自动加载额外上下文。\n\n';
section('9. 附录：Decide 初始提示词',promptFor({kind:'decide'} as any,{动态占位:'当前项目有界视图'},{} as any)+literal(variables.get('finalInstruction')!));
section('10. 附录：Review 初始提示词',promptFor({kind:'review'} as any,{动态占位:'当前 Finding 和项目有界视图'},{} as any)+literal(variables.get('finalInstruction')!));
mkdirSync('.tessera', { recursive: true });
writeFileSync('.tessera/work-prompts.md',report);
console.log('Exported .tessera/work-prompts.md ('+report.length+' characters)');
