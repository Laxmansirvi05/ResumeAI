import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { BrandIcon } from "@reactive-resume/ui/components/brand-icon";

export function LoadingScreen() {
	return (
		<div className="fixed inset-0 z-50 flex h-svh w-svw flex-col items-center justify-center bg-background dark:bg-zinc-950">
			<m.div
				initial={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
				animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
				transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
				className="flex flex-col items-center gap-y-6"
			>
				<BrandIcon className="size-16" />
				<m.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 1, delay: 0.2 }}
					className="flex flex-col items-center gap-y-2"
				>
					<p className="font-medium text-lg tracking-tight">ResumeAI</p>
					<p className="text-muted-foreground text-sm">
						<Trans>Loading your experience...</Trans>
					</p>
				</m.div>
			</m.div>
		</div>
	);
}
