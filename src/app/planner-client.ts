import {
  AIPlannerResponseSchema,
  type PlannerRequest,
  type PlannerResponse,
} from "../shared/planner-contract";
import type { Result } from "../shared/result";

const PLANNER_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export type PlannerClientError =
  | { kind: "aborted"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "http"; status: number; message: string }
  | { kind: "response-too-large"; message: string }
  | { kind: "invalid-response"; message: string }
  | { kind: "network"; message: string };

const readBoundedText = async (
  response: Response,
): Promise<Result<string, PlannerClientError>> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      return {
        ok: false,
        error: {
          kind: "response-too-large",
          message: "Planner response exceeded 64 KiB.",
        },
      };
    }
  }

  if (response.body === null) return { ok: true, value: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return {
        ok: false,
        error: {
          kind: "response-too-large",
          message: "Planner response exceeded 64 KiB.",
        },
      };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: new TextDecoder().decode(bytes) };
};

export const requestPlan = async (
  request: PlannerRequest,
  resetSignal: AbortSignal,
): Promise<Result<PlannerResponse, PlannerClientError>> => {
  const timeoutSignal = AbortSignal.timeout(PLANNER_TIMEOUT_MS);
  const signal = AbortSignal.any([resetSignal, timeoutSignal]);

  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "http",
          status: response.status,
          message: `Planner endpoint returned HTTP ${response.status}.`,
        },
      };
    }

    const body = await readBoundedText(response);
    if (!body.ok) return body;
    let value: unknown;
    try {
      value = JSON.parse(body.value);
    } catch {
      return {
        ok: false,
        error: { kind: "invalid-response", message: "Planner response was not valid JSON." },
      };
    }
    const parsed = AIPlannerResponseSchema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: "invalid-response", message: "Planner response failed validation." },
      };
    }
    return { ok: true, value: parsed.data };
  } catch {
    if (resetSignal.aborted) {
      return {
        ok: false,
        error: { kind: "aborted", message: "Planner request was aborted." },
      };
    }
    if (timeoutSignal.aborted) {
      return {
        ok: false,
        error: { kind: "timeout", message: "Planner request timed out." },
      };
    }
    return {
      ok: false,
      error: { kind: "network", message: "Planner request failed." },
    };
  }
};
