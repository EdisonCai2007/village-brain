import type {
  PlannerRequest,
  PlannerResponse,
} from "../shared/planner-contract";
import type { Result } from "../shared/result";
import { requestPlan, type PlannerClientError } from "./planner-client";

export type PlannerStatus = "idle" | "collecting" | "planning" | "executing";

export interface PlannerExecution {
  request: PlannerRequest;
  response: PlannerResponse;
  source: "ai" | "fallback";
  error?: PlannerClientError;
}

export interface PlannerCoordinatorPort {
  createRequest(eventIds: readonly string[]): PlannerRequest;
  createFallback(request: PlannerRequest, error: PlannerClientError): PlannerResponse;
  executePlan(execution: PlannerExecution): void | Promise<void>;
}

export type PlannerClient = (
  request: PlannerRequest,
  signal: AbortSignal,
) => Promise<Result<PlannerResponse, PlannerClientError>>;

export interface PlannerCoordinatorOptions {
  port: PlannerCoordinatorPort;
  client?: PlannerClient;
  quietWindowMs?: number;
}

type StatusListener = (status: PlannerStatus) => void;

export class PlannerCoordinator {
  readonly #port: PlannerCoordinatorPort;
  readonly #client: PlannerClient;
  readonly #quietWindowMs: number;
  readonly #pendingEventIds = new Set<string>();
  readonly #listeners = new Set<StatusListener>();
  #status: PlannerStatus = "idle";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #windowReady = false;
  #inFlight: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #generation = 0;

  constructor({ port, client = requestPlan, quietWindowMs = 1_000 }: PlannerCoordinatorOptions) {
    if (!Number.isFinite(quietWindowMs) || quietWindowMs < 0) {
      throw new TypeError("Planner quiet window must be a non-negative finite number.");
    }
    this.#port = port;
    this.#client = client;
    this.#quietWindowMs = quietWindowMs;
  }

  get status(): PlannerStatus {
    return this.#status;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  queueEvent(eventId: string): void {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new TypeError("Planner events require a non-empty ID.");
    }
    this.#pendingEventIds.add(eventId);
    this.#windowReady = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#windowReady = true;
      this.#startReadyWindow();
    }, this.#quietWindowMs);
    if (this.#inFlight === null) this.#setStatus("collecting");
  }

  reset(): void {
    this.#generation += 1;
    this.#pendingEventIds.clear();
    this.#windowReady = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#abortController?.abort();
    this.#setStatus("idle");
  }

  #setStatus(status: PlannerStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  #startReadyWindow(): void {
    if (
      !this.#windowReady
      || this.#inFlight !== null
      || this.#pendingEventIds.size === 0
    ) return;

    const eventIds = [...this.#pendingEventIds];
    this.#pendingEventIds.clear();
    this.#windowReady = false;
    const request = this.#port.createRequest(eventIds);
    const generation = this.#generation;
    const controller = new AbortController();
    this.#abortController = controller;
    this.#setStatus("planning");

    const work = this.#runPlan(request, controller, generation);
    this.#inFlight = work;
    void work.then(() => this.#settle(work, controller));
  }

  async #runPlan(
    request: PlannerRequest,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    let result: Result<PlannerResponse, PlannerClientError>;
    try {
      result = await this.#client(request, controller.signal);
    } catch {
      result = {
        ok: false,
        error: { kind: "network", message: "Planner request failed." },
      };
    }

    if (generation !== this.#generation || controller.signal.aborted) return;
    const execution: PlannerExecution = result.ok
      ? { request, response: result.value, source: "ai" }
      : {
          request,
          response: this.#port.createFallback(request, result.error),
          source: "fallback",
          error: result.error,
        };
    this.#setStatus("executing");
    try {
      await this.#port.executePlan(execution);
    } catch {
      // Execution is engine-owned. A failed execution must not recursively plan.
    }
  }

  #settle(work: Promise<void>, controller: AbortController): void {
    if (this.#inFlight !== work) return;
    this.#inFlight = null;
    if (this.#abortController === controller) this.#abortController = null;
    if (this.#pendingEventIds.size > 0) {
      if (this.#windowReady) this.#startReadyWindow();
      else this.#setStatus("collecting");
      return;
    }
    this.#setStatus("idle");
  }
}
