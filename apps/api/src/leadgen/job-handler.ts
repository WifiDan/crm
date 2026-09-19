export type LgJobContext = {
	runId: string;
	jobName: string;
	signal: AbortSignal;
};

export type LgJobResult = {
	counters: Record<string, number | string>;
};

export interface LgJobHandler {
	readonly name: string;
	run(ctx: LgJobContext): Promise<LgJobResult>;
}

export const LG_JOB_HANDLERS = Symbol("LG_JOB_HANDLERS");
