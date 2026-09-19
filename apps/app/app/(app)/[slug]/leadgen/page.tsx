import type { Metadata } from "next";
import {
	PageShell,
	PageShellContent,
	PageShellDescription,
	PageShellHeader,
	PageShellHeading,
	PageShellTitle,
} from "@/components/page-shell";
import { requireSession } from "@/lib/session";
import { LeadgenConsole } from "./leadgen-console";

export const metadata: Metadata = {
	title: "Lead Gen",
};

export default async function LeadgenPage() {
	await requireSession();
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
				<LeadgenConsole />
			</PageShellContent>
		</PageShell>
	);
}
