import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  DELEGATE_QUESTION,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

/**
 * The Jev request for one routing decision. `history` is the recent conversation from
 * `recentContext`, so a terse follow-up is judged by the work it continues.
 */
export function jevRequest({ prompt, current, contextTokens, models, history, subagent }) {
  return {
    state: {
      request: prompt,
      ...(history && { conversation_before_request: history }),
      session: {
        current_model: current,
        context_tokens: contextTokens,
        ...(subagent && {
          role: "Sub-agent: a self-contained task delegated by the main agent, which only gets the result back.",
        }),
      },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models, history, subagent }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = jevRequest({ prompt, current, contextTokens, models, history, subagent });
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...answer,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      newTask: history ? (result.answers.new_task?.noul ?? null) : null,
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Jev's probability that a prompt is self-contained bulky gathering worth handing to a
 * sub-agent, or null on any failure. Kept to one question so the prompt hook stays fast.
 */
export async function askDelegation({ prompt, history }) {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    const result = await getClient().systemOne(
      {
        state: { request: prompt, ...(history && { conversation_before_request: history }) },
        questions: { delegate: DELEGATE_QUESTION },
      },
      { signal: abort.signal },
    );
    return result.answers.delegate?.noul ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
