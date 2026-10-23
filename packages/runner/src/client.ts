import type { Job } from "../../protocol/src/index.js";
import { randomUUID } from "node:crypto";
export interface CommitAttempt {
  stage: "prepared" | "attempt_start" | "attempt_accepted" | "attempt_error";
  operation: string; submission_id: string; run_id?: string; attempt: number;
  elapsed_ms?: number; status?: number | null; error?: string;
  payload_hash?: string; submission_file?: string; final?: boolean;
}
export class ApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`API ${status}: ${detail}`);
  }
}
export class ApiClient {
  constructor(
    readonly base: string,
    readonly token = "",
  ) {}
  async request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    timeoutMs = 30000,
  ): Promise<T> {
    const response = await fetch(this.base.replace(/\/$/, "") + "/api" + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // A project-scoped token is sent under its own header; the global token
        // (dispatcher/recovery) still satisfies the worker header.
        ...(this.token ? { "x-tessera-worker-token": this.token, "x-tessera-project-token": this.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new ApiError(response.status, (await response.text()).slice(0, 2000));
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async commit<T>(path: string, body: Record<string, unknown>, runId?: string, key: string = randomUUID(),
    observe?: (event: CommitAttempt) => void): Promise<T> {
    const payload = { ...body, submission_id: key, ...(runId ? { run_id: runId } : {}) };
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const emit = (event: Omit<CommitAttempt, "operation" | "submission_id" | "run_id" | "attempt">) => {
        try { observe?.({ ...event, operation: path, submission_id: key, run_id: runId, attempt: attempt + 1 }); } catch {}
      };
      emit({ stage: "attempt_start" });
      try {
        const result = await this.request<T>(path, payload, "POST", 10000);
        emit({ stage: "attempt_accepted", elapsed_ms: Date.now() - started });
        return result;
      }
      catch (error) {
        emit({ stage: "attempt_error", elapsed_ms: Date.now() - started,
          status: error instanceof ApiError ? error.status : null, error: error instanceof Error ? error.message : String(error) });
        // Semantic conflicts (especially stale Decide snapshots) must be refreshed, never retried blindly.
        if (attempt >= 2 || (error instanceof ApiError && error.status < 500)) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  projectPath(job: Job, suffix = "") {
    return `/projects/${encodeURIComponent(job.project_id)}${suffix}`;
  }
}
