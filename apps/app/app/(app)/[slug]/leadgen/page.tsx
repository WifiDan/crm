import type { Metadata } from "next";
import { Suspense } from "react";
import {
	PageShell,
	PageShellContent,
	PageShellDescription,
	PageShellHeader,
	PageShellHeading,
	PageShellLoading,
	PageShellTitle,
} from "@/components/page-shell";
import { requireSession } from "@/lib/session";
import { LeadgenConsole } from "./leadgen-console";

export const metadata: Metadata = {
	title: "Lead Gen",
};

export default function LeadgenPage() {
	return (
		<PageShell>
			<PageShellHeader>
				<PageShellHeading>
					<PageShellTitle>Lead Gen</PageShellTitle>
					<PageShellDescription>
						Scheduled jobs, the NocoDB lead mirror, markets and alerts.
					</PageShellDescription>
				</PageShellHeading>
			</PageShellHeader>
			<PageShellContent>
				<Suspense fallback={<PageShellLoading />}>
					<Leadgen />
				</Suspense>
			</PageShellContent>
		</PageShell>
	);
}

async function Leadgen() {
	await requireSession();
	return <LeadgenConsole />;
}
