import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getShellConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { toolEnvironment } from "./tool-environment.js";

// Separate from the Worker and command groups, so even SIGKILL of the Worker
// releases its commands. Linux start times distinguish a reused PID.
const watchdog = `
const fs=require('node:fs'),cp=require('node:child_process');
const [owner,target,file,ownerBirth,targetBirth]=process.argv.slice(1);
function birth(pid){try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').slice(1).join(') ').split(' ')[19]}catch{return ''}}
function alive(pid,stamp){try{process.kill(Number(pid),0);if(process.platform==='linux'){const state=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').slice(1).join(') ').split(' ')[0];if(state==='Z'||state==='X')return false}return !stamp||birth(pid)===stamp}catch{return false}}
function kill(){try{if(process.platform==='win32')cp.spawnSync('taskkill',['/pid',target,'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-Number(target),'SIGKILL')}catch{}}
const timer=setInterval(()=>{
 const parent=alive(owner,ownerBirth),child=alive(target,targetBirth);
 if(parent&&child)return;
 // Do not signal a new process that has reused the command leader's PID.
 if(!child&&targetBirth&&birth(target)&&birth(target)!==targetBirth){clearInterval(timer);return}
 if(!parent){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.status==='running'){data.status='interrupted';data.error='Worker exited';data.finished_at=new Date().toISOString();const tmp=file+'.watchdog';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file)}}catch{}}
 kill();clearInterval(timer);
},500);
`;

// A poll/yield is only a wait on an already-running command, so it can safely
// block longer than an HTTP request. 120 s keeps long scans from costing one
// full model round trip every 30 s, while still bounding how long a due closeout
// or task deadline can be delayed by an in-flight tool call.
const MAX_WAIT_MS = 120_000;
type ProcessStatus = "running" | "exited" | "stopped" | "timed_out" | "failed" | "interrupted";
type RecordData = {
  process_id: string;
  project_id: string;
  run_id?: string;
  step_id?: string;
  worker: string;
  command: string;
  pid?: number;
  status: ProcessStatus;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  error?: string;
  log_path: string;
};
type Managed = {
  data: RecordData;
  child: ChildProcess;
  file: string;
  done: Promise<void>;
  resolve: () => void;
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class ProcessSessions {
  private entries = new Map<string, Managed>();
  private closing = false;
  constructor(
    readonly directory: string,
    readonly cwd: string,
    readonly owner: { project_id: string; run_id?: string; step_id?: string; worker: string },
  ) {
    mkdirSync(directory, { recursive: true });
  }
  private save(entry: Managed) {
    const temporary = entry.file + ".tmp";
    writeFileSync(temporary, JSON.stringify(entry.data, null, 2), { mode: 0o600 });
    renameSync(temporary, entry.file);
  }
  private birth(pid: number) {
    if (process.platform !== "linux") return "";
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").slice(1).join(") ").split(" ")[19];
    } catch {
      return "";
    }
  }
  private kill(entry: Managed) {
    if (!entry.data.pid) return;
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/pid", String(entry.data.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-entry.data.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  private get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Process does not belong to this Run");
    return entry;
  }
  async start(command: string, timeout?: number) {
    if (this.closing) throw new Error("Run no longer accepts commands");
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647))
      throw new Error("Invalid timeout: supply a positive finite number of seconds, at most 2147483.647");
    const id = `process_${randomUUID()}`,
      log = join(this.directory, `${id}.log`),
      file = join(this.directory, `${id}.json`);
    const shell = getShellConfig();
    const input = shell.commandTransport === "stdin";
    const fd = openSync(log, "wx", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(shell.shell, input ? shell.args : [...shell.args, command], {
        cwd: this.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: toolEnvironment(),
        stdio: [input ? "pipe" : "ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const entry: Managed = {
      data: {
        ...this.owner,
        process_id: id,
        command,
        pid: child.pid,
        status: "running",
        started_at: new Date().toISOString(),
        log_path: log,
      },
      child,
      file,
      done,
      resolve,
      offset: 0,
    };
    this.entries.set(id, entry);
    this.save(entry);
    const finish = (code: number | null, signal?: string | null, error?: Error) => {
      clearTimeout(entry.timer);
      // A shell may exit while background children retain its group and log FD.
      // End those children before marking the raw log ready for archival.
      this.kill(entry);
      if (entry.data.status === "running") entry.data.status = error ? "failed" : "exited";
      Object.assign(entry.data, {
        exit_code: code,
        signal: signal ?? null,
        finished_at: new Date().toISOString(),
        ...(error ? { error: error.message } : {}),
      });
      this.save(entry);
      entry.resolve();
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, signal) => {
      if (!entry.data.finished_at) finish(code, signal);
    });
    if (input) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }
    if (timeout !== undefined)
      entry.timer = setTimeout(() => {
        if (entry.data.status !== "running") return;
        entry.data.status = "timed_out";
        this.kill(entry);
      }, timeout * 1000);
    if (child.pid) {
      const watcher = spawn(
        process.execPath,
        ["-e", watchdog, String(process.pid), String(child.pid), file, this.birth(process.pid), this.birth(child.pid)],
        { detached: true, windowsHide: true, stdio: "ignore", env: toolEnvironment() },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          watcher.once("spawn", resolve);
          watcher.once("error", reject);
        });
      } catch (error) {
        this.kill(entry);
        await done;
        throw error;
      }
      watcher.unref();
    }
    return id;
  }
  async poll(id: string, waitMs = 1000, offset?: number) {
    const entry = this.get(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (entry.data.status === "running" && waitMs > 0)
        await Promise.race([
          entry.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(MAX_WAIT_MS, waitMs));
          }),
        ]);
    } finally {
      clearTimeout(timer);
    }
    const from = offset ?? entry.offset;
    const handle = await open(entry.data.log_path, "r");
    let text = "",
      length = 0,
      total = 0;
    try {
      total = (await handle.stat()).size;
      const bytes = Buffer.alloc(Math.min(12000, Math.max(0, total - from)));
      const read = await handle.read(bytes, 0, bytes.length, from);
      length = read.bytesRead;
      if (length && (entry.data.status === "running" || from + length < total)) {
        let lead = length - 1;
        while (lead > 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
        const first = bytes[lead],
          size = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (lead + size > length) length = lead;
      }
      text = bytes.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    entry.offset = from + length;
    return {
      ...entry.data,
      elapsed_ms:
        (entry.data.finished_at ? Date.parse(entry.data.finished_at) : Date.now()) - Date.parse(entry.data.started_at),
      output: text,
      offset: from,
      next_offset: entry.offset,
      output_bytes: total,
      has_more: entry.offset < total,
    };
  }
  list() {
    return [...this.entries.values()].map((entry) => ({
      ...entry.data,
      elapsed_ms:
        (entry.data.finished_at ? Date.parse(entry.data.finished_at) : Date.now()) - Date.parse(entry.data.started_at),
    }));
  }
  async stop(id: string) {
    const entry = this.get(id);
    if (entry.data.status === "running") {
      entry.data.status = "stopped";
      this.kill(entry);
    }
    await entry.done;
    return this.poll(id, 0);
  }
  async close() {
    this.closing = true;
    const running = this.list().filter((item) => item.status === "running");
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => !entry.data.finished_at)
        .map((entry) => this.stop(entry.data.process_id)),
    );
    return running.map((item) => item.process_id);
  }
}

export function processTools(manager: ProcessSessions): ToolDefinition[] {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  // A tool-level abort cancels that one operation. It must not put the whole Run
  // into a permanently closing state: the model may still need a later command.
  const withCancellation = async <T>(signal: AbortSignal | undefined, action: Promise<T>) => {
    if (signal?.aborted) throw new Error("Command cancelled");
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Command cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([action, cancelled]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
  return [
    {
      name: "bash",
      label: "bash",
      description:
        "Execute a shell command. Returns exit status or running with process_id, output and log_path. yield_time_ms (max 120000) only bounds this wait; a running command continues. For a scan expected to finish, prefer one long yield (e.g. 60000-120000) over repeated short polls. Optional timeout is a command deadline in seconds. Output offsets are bytes.",
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number()),
        yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
      }),
      execute: async (_id, args: any, signal) => {
        if (signal?.aborted) throw new Error("Command cancelled");
        const processId = await manager.start(args.command, args.timeout);
        const abort = () => {
          void manager.stop(processId).catch(() => {});
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) abort();
          return result(await manager.poll(processId, args.yield_time_ms ?? 10000));
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    },
    {
      name: "process",
      label: "process",
      description:
        "List this Run's shell processes, poll status and output, or stop a process group. poll can wait up to 120000 ms without terminating the command; use a long wait for a scan you expect to finish instead of many 30 s polls. offset re-reads a byte position in the raw log. Cannot start commands.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("poll"), Type.Literal("stop")]),
        process_id: Type.Optional(Type.String()),
        wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (_id, args: any, signal) => {
        if (signal?.aborted) throw new Error("Command cancelled");
        if (args.action === "list") return result(manager.list());
        if (!args.process_id) throw new Error("process_id is required");
        const action =
          args.action === "stop"
            ? manager.stop(args.process_id)
            : manager.poll(args.process_id, args.wait_ms, args.offset);
        return result(await withCancellation(signal, action));
      },
    },
  ];
}
