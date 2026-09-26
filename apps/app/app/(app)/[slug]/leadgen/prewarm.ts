"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTRPC } from "@/lib/trpc/client";

/**
 * How many leads below the current one should have a screenshot + audit
 * ready before the person gets there. Kept small on purpose: this is a
 * rolling window, not a whole-list prewarm, so it stays cheap and the
 * server only ever has one screenshot browser running for prewarming at
 * a time (see LeadgenPrewarmService on the API side).
 */
export const PREWARM_WINDOW = 5;

/**
 * The ids that should be warmed next: the `windowSize` ids after
 * `currentId` in `ids`, in order. Pulled out on its own so the windowing
 * logic can be tested without React.
 */
export function nextPrewarmIds(
	ids: readonly string[],
	currentId: string | null,
	windowSize: number = PREWARM_WINDOW,
): string[] {
	if (!currentId) return [];
	const at = ids.indexOf(currentId);
	if (at < 0) return [];
	return ids.slice(at + 1, at + 1 + windowSize);
}

/**
 * Keeps the next `windowSize` leads below `currentId` warm: their
 * screenshot and site audit are captured server-side ahead of time, so
 * opening one of them renders instantly instead of waiting on a fresh
 * Chrome capture or a live site fetch.
 *
 * Each lead id is only ever requested once per mount of this hook; moving
 * to the next lead slides the window and asks for exactly one more.
 */
export function usePrewarmWindow(
	ids: readonly string[],
	currentId: string | null,
	windowSize: number = PREWARM_WINDOW,
) {
	const trpc = useTRPC();
	const prewarm = useMutation(trpc.leadgenPrewarm.prepare.mutationOptions());
	const requested = useRef<Set<string>>(new Set());

	// biome-ignore lint/correctness/useExhaustiveDependencies: prewarm is a stable useMutation handle; only the window inputs should re-trigger this effect.
	useEffect(() => {
		for (const id of nextPrewarmIds(ids, currentId, windowSize)) {
			if (requested.current.has(id)) continue;
			requested.current.add(id);
			prewarm.mutate({ id });
		}
	}, [ids, currentId, windowSize]);
}
