export type AuditData = {
	score: number;
	priority: "Low" | "Medium" | "High" | "Error";
	signals: string[];
	url: string;
};

export type AuditTone = "destructive" | "outline" | "secondary";

export function auditView(data: AuditData): {
	headline: string;
	tone: AuditTone;
	lines: string[];
	empty: string | null;
} {
	const tone: AuditTone =
		data.priority === "Low"
			? "secondary"
			: data.priority === "Medium"
				? "outline"
				: "destructive";
	const headline =
		data.priority === "Error"
			? "Audit failed"
			: `Priority: ${data.priority} | Score: ${data.score}/100`;
	return {
		headline,
		tone,
		lines: data.signals,
		empty:
			data.signals.length === 0 && data.priority !== "Error"
				? "No outdated signals detected."
				: null,
	};
}
