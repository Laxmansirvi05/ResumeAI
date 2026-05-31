import { Trans } from "@lingui/react/macro";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { m } from "motion/react";
import { Button } from "@reactive-resume/ui/components/button";

export function FinalCTA() {
	return (
		<section id="final-cta" className="relative overflow-hidden py-24 md:py-32">
			{/* Background decoration */}
			<div aria-hidden="true" className="pointer-events-none absolute inset-0">
				<div className="absolute inset-s-1/4 top-0 size-96 rounded-full bg-primary/5 blur-3xl" />
				<div className="absolute inset-e-1/4 bottom-0 size-96 rounded-full bg-primary/5 blur-3xl" />
			</div>

			<m.div
				className="relative mx-auto max-w-2xl space-y-8 px-6 text-center will-change-[transform,opacity] md:px-8 xl:px-0"
				initial={{ opacity: 0, y: 24 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.5 }}
			>
				<h2 className="font-semibold text-3xl tracking-tight md:text-5xl">
					<Trans>Build Your Resume with AI</Trans>
				</h2>

				<p className="mx-auto max-w-lg text-muted-foreground leading-relaxed">
					<Trans>
						Import your existing resume, choose a premium template, and export a polished PDF — all in minutes.
					</Trans>
				</p>

				<m.div
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.4, delay: 0.15 }}
				>
					<Button
						size="lg"
						nativeButton={false}
						className="group relative overflow-hidden px-6"
						render={
							<Link to="/dashboard">
								<span className="relative z-10 flex items-center gap-2">
									<Trans>Get Started</Trans>
									<ArrowRightIcon
										aria-hidden="true"
										className="size-4 transition-transform group-hover:translate-x-0.5"
									/>
								</span>
							</Link>
						}
					/>
				</m.div>
			</m.div>
		</section>
	);
}
