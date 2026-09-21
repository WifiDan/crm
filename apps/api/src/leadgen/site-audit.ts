export type AuditPriority = "Low" | "Medium" | "High" | "Error";

export type AuditResult = {
	score: number;
	priority: AuditPriority;
	signals: string[];
	url: string;
};

export function scoreSite(html: string, target: string): AuditResult {
	const signals: string[] = [];
	let score = 100;

	const jqMatches = html.match(/jquery[.-](\d+\.\d+\.\d+)/i);
	if (jqMatches) {
		const v = jqMatches[1] as string;
		if (v.startsWith("1.") || v.startsWith("2.")) {
			signals.push(`jQuery ${v} (2014-2016, 8-10 years old)`);
			score -= 25;
		}
	}

	if (!html.includes("viewport")) {
		signals.push("No mobile viewport meta tag (not responsive)");
		score -= 20;
	}

	if (!target.startsWith("https")) {
		signals.push("HTTP only (no HTTPS/SSL)");
		score -= 15;
	}

	if (
		(html.includes("wp-content") && html.includes("Genesis")) ||
		html.includes("Divi")
	) {
		signals.push("WordPress with legacy theme (Genesis/Divi)");
		score -= 10;
	}

	if (html.match(/jquery\.(slick|nivo|paroller|superfish)/i)) {
		signals.push("Old jQuery plugins (slick, nivo, paroller, superfish)");
		score -= 15;
	}

	if (html.match(/<(embed|object|applet)/i)) {
		signals.push("Flash/Java elements (extremely outdated)");
		score -= 30;
	}

	const copyrightMatch = html.match(/20(1[0-5])\s*[-&]|&copy;\s*20(1[0-5])/);
	if (copyrightMatch) {
		signals.push(
			`Old copyright date detected (20${copyrightMatch[1] || copyrightMatch[2]})`,
		);
		score -= 10;
	}

	score = Math.max(0, score);
	const priority = score >= 70 ? "Low" : score >= 40 ? "Medium" : "High";

	return { score, priority, signals, url: target };
}

export function auditFailure(target: string, message: string): AuditResult {
	return {
		score: 0,
		priority: "Error",
		signals: [`Could not audit: ${message}`],
		url: target,
	};
}
