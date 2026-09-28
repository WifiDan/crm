export type LgScheduleSpec = {
	scheduleKind: "INTERVAL" | "DAILY";
	intervalSeconds: number | null;
	dailyAt: string | null;
	timezone: string;
};

function tzOffsetMs(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(date);
	const m: Record<string, string> = {};
	for (const p of parts) m[p.type] = p.value;
	const asUtc = Date.UTC(
		Number(m.year),
		Number(m.month) - 1,
		Number(m.day),
		Number(m.hour),
		Number(m.minute),
		Number(m.second),
	);
	return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function nextDailyRun(from: Date, hhmm: string, timeZone: string): Date {
	const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
	if (!match) throw new Error(`dailyAt must be HH:MM, got "${hhmm}"`);
	const hh = Number(match[1]);
	const mm = Number(match[2]);
	const localNow = new Date(from.getTime() + tzOffsetMs(from, timeZone));
	for (let add = 0; add < 3; add++) {
		const guessLocal = Date.UTC(
			localNow.getUTCFullYear(),
			localNow.getUTCMonth(),
			localNow.getUTCDate() + add,
			hh,
			mm,
			0,
		);
		let instant = guessLocal - tzOffsetMs(new Date(guessLocal), timeZone);
		instant = guessLocal - tzOffsetMs(new Date(instant), timeZone);
		if (instant > from.getTime()) return new Date(instant);
	}
	throw new Error("could not compute next daily run");
}

export function nextRunAfter(spec: LgScheduleSpec, from: Date): Date {
	if (spec.scheduleKind === "INTERVAL") {
		if (!spec.intervalSeconds || spec.intervalSeconds < 10) {
			throw new Error("INTERVAL jobs need intervalSeconds >= 10");
		}
		return new Date(from.getTime() + spec.intervalSeconds * 1000);
	}
	if (!spec.dailyAt) throw new Error("DAILY jobs need dailyAt");
	return nextDailyRun(from, spec.dailyAt, spec.timezone);
}
