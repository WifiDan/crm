/**
 * Card #589: quota/credit-exhaustion circuit breaker.
 *
 * eve already classifies model-call failures and stamps a `code` onto
 * `step.failed` / `turn.failed` / `session.failed` (see
 * `agent/hooks/telemetry.ts`, which already reads this same `code` for its
 * own model-error metric). When that code (or the failure message) looks
 * like a provider quota/credit/rate-limit exhaustion, this hook trips the
 * dispatch breaker in `agent/lib/quota-pause.ts` instead of letting the
 * run fail-and-retry-and-fail-again.
 *
 * This does NOT touch eve's own internal retry/recovery behavior (that is
 * vendored, compiled code we don't own the source of) — it only stops
 * *our* dispatch loop (`agent/lib/dispatch.ts`,
 * `agent/lib/custom-agent-dispatch.ts`) from starting more work while the
 * provider is broke. Startup-time mass re-delivery of already-active
 * eve workflow runs is capped separately via `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS`
 * and `WORKFLOW_LOCAL_QUEUE_CONCURRENCY` in the systemd unit.
 */
import { defineHook } from "eve/hooks";
import { classifyQuotaError, pauseDispatchForQuota } from "../lib/quota-pause";

async function maybePause(code: string, message: string): Promise<void> {
	if (!classifyQuotaError({ code, message })) return;
	await pauseDispatchForQuota({ code, message }).catch((error) => {
		console.error(
			`[agent] quota-guard: failed to persist pause state: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	});
}

export default defineHook({
	events: {
		async "step.failed"(event) {
			await maybePause(event.data.code, event.data.message);
		},

		async "turn.failed"(event) {
			await maybePause(event.data.code, event.data.message);
		},

		async "session.failed"(event) {
			await maybePause(event.data.code, event.data.message);
		},
	},
});
