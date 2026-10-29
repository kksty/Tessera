import { findingAssets, stepAssets } from "../../../packages/protocol/src/asset-scope.js";
import { randomUUID } from "node:crypto";
import type { DispatchConfig, Job, ProjectSummary, Graph } from "../../../packages/protocol/src/index.js";
import { ApiClient } from "../../../packages/runner/src/client.js";
import type { JobBackend } from "./docker.js";

export class Dispatcher {
  readonly running = new Map<string, { job: Job; controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  private lastClaimedProject?: string;
  constructor(
    readonly client: ApiClient,
    readonly backend: JobBackend,
  ) {}
  async tick(config: DispatchConfig) {
    if (this.stopping) return [];
    const projects = await this.client.request<ProjectSummary[]>("/projects");
    for (const task of this.running.values())
      if (!projects.some((p) => p.id === task.job.project_id && p.status === "active")) task.controller.abort();
    const activeGraphs = new Map<string, Graph>();
    for (const task of this.running.values()) {
      if (task.job.kind === "decide" || task.controller.signal.aborted) continue;
      let graph = activeGraphs.get(task.job.project_id);
      if (!graph) {
        graph = await this.client.request<Graph>(`/projects/${task.job.project_id}`);
        activeGraphs.set(task.job.project_id, graph);
      }
      if (task.job.kind === "execute") {
        const step = graph.steps.find((s) => s.id === task.job.step_id);
        if (
          !step ||
          step.deleted ||
          step.discarded ||
          step.worker !== task.job.worker ||
          (task.job.run_id && step.run_id !== task.job.run_id) ||
          stepAssets(graph, step).some((id) => !graph!.assets.some((a) => a.id === id && a.approval === "approved"))
        )
          task.controller.abort();
      } else if (task.job.kind === "peer") {
        // peer 回合在 peer 退出、被删除或租约易主时中止。
        const peer = (graph.peers ?? []).find((p) => p.id === task.job.peer_id);
        if (!peer || peer.status !== "active") task.controller.abort();
      } else {
        const finding = graph.findings.find((f) => f.id === task.job.finding_id);
        if (
          !finding ||
          finding.deleted ||
          finding.review_worker !== task.job.worker ||
          finding.version !== task.job.finding_version ||
          (task.job.run_id && finding.review_run_id !== task.job.run_id) ||
          findingAssets(graph, finding).some(
            (id) => !graph!.assets.some((a) => a.id === id && a.approval === "approved"),
          )
        )
          task.controller.abort();
      }
    }
    if (!config.model.id || !config.model.base_url) return projects;
    const ready = new Map<string, boolean>();
    for (const project of projects.filter((p) => p.status === "active")) {
      try {
        ready.set(
          project.id,
          this.backend.prepare
            ? await this.backend.prepare(
                project.id,
                config,
                [...this.running.values()].some((t) => t.job.project_id === project.id),
              )
            : true,
        );
      } catch (error) {
        ready.set(project.id, false);
        console.error(`${project.id} worker preparation: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
    // Resume after the last successful claim even when only one slot opens per tick.
    const lastIndex = projects.findIndex((p) => p.id === this.lastClaimedProject);
    const ordered = lastIndex < 0 ? projects : [...projects.slice(lastIndex + 1), ...projects.slice(0, lastIndex + 1)];
    // One pass per project before filling further slots prevents a large project monopolizing all workers.
    for (let round = 0; round < config.max_project_workers && this.running.size < config.max_workers; round++)
      for (const project of ordered) {
        if (project.status !== "active" || !ready.get(project.id) || this.running.size >= config.max_workers) continue;
        if (
          [...this.running.values()].filter((t) => t.job.project_id === project.id).length >= config.max_project_workers
        )
          continue;
        const worker = `w_${randomUUID()}`;
        // The claim id makes an abandoned claim identifiable: if this client times
        // out while the server is still creating the lease, the cancel below ends
        // that Run instead of leaving an orphan that blocks the Step.
        const claimId = randomUUID();
        let job: Job | null;
        const claimPath = `/projects/${project.id}/jobs/claim`;
        const claimBody = { worker, debounce_ms: config.debounce_ms, claim_id: claimId };
        try {
          // Test doubles implement only request(); the longer claim budget is a
          // property of the real client, not of the dispatcher contract.
          job =
            typeof this.client.control === "function"
              ? await this.client.control<Job | null>(claimPath, claimBody)
              : await this.client.request<Job | null>(claimPath, claimBody);
        } catch (error) {
          // One project's claim failure (lease race, deletion lock) must not skip
          // the other projects or the reconcile pass.
          console.error(`${project.id} claim: ${error instanceof Error ? error.message : "unavailable"}`);
          void this.client
            .request(
              `${claimPath}/${encodeURIComponent(claimId)}/cancel`,
              { worker },
              "POST",
              this.client.timeouts?.cancel_ms ?? 5000,
            )
            .catch(() => {});
          continue;
        }
        if (!job) continue;
        this.lastClaimedProject = project.id;
        const controller = new AbortController();
        const promise = (async () => {
          let error: string | undefined;
          try {
            await this.backend.run(job, config, controller.signal);
          } catch (e) {
            error = controller.signal.aborted ? undefined : e instanceof Error ? e.message : "Worker failed";
            if (error) console.error(`${job.project_id} ${job.kind}: ${error}`);
          } finally {
            await this.client
              .request(
                `/projects/${job.project_id}/jobs/release`,
                {
                  job,
                  error,
                },
                "POST",
                this.client.timeouts?.release_ms ?? 30_000,
              )
              .catch(() => {});
            this.running.delete(worker);
          }
        })();
        this.running.set(worker, { job, controller, promise });
      }
    return projects;
  }
  async stop() {
    this.stopping = true;
    const tasks = [...this.running.values()];
    for (const t of tasks) t.controller.abort();
    await Promise.allSettled(tasks.map((t) => t.promise));
  }
  async cancelProject(projectId: string) {
    const tasks = [...this.running.values()].filter((task) => task.job.project_id === projectId);
    for (const task of tasks) task.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(tasks.map((task) => task.promise)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("项目任务尚未退出，请稍后重试删除")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
