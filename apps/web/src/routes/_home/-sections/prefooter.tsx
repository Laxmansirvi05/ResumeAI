import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { TextMaskEffect } from "@/components/animation/text-mask";

export function Prefooter() {
	return (
		<section id="prefooter" className="relative overflow-hidden py-16 md:py-24">
			{/* Background decoration */}
			<div aria-hidden="true" className="pointer-events-none absolute inset-0">
				<div className="absolute inset-s-1/4 top-0 size-96 rounded-full bg-primary/5 blur-3xl" />
				<div className="absolute inset-e-1/4 bottom-0 size-96 rounded-full bg-primary/5 blur-3xl" />
			</div>

			<div className="relative space-y-8">
				<TextMaskEffect aria-hidden="true" text="ResumeAI" className="hidden md:block" />

				<m.div
					className="mx-auto max-w-3xl space-y-8 px-6 text-center will-change-[transform,opacity] md:px-8 xl:px-0"
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.45 }}
				>
					<h2 className="font-semibold text-2xl tracking-tight md:text-4xl">
						<Trans>The future of resume building.</Trans>
					</h2>

					<p className="text-muted-foreground leading-relaxed">
						<Trans>
							ResumeAI uses cutting-edge artificial intelligence to help you craft the perfect ATS-optimized resume in
							minutes. Experience a completely redesigned platform focusing on minimal aesthetics, dynamic content
							generation, and unparalleled customization.
						</Trans>
					</p>
				</m.div>
			</div>
		</section>
	);
}
