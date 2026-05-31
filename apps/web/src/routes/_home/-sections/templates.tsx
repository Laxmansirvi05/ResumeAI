import type { TemplateMetadata } from "@/dialogs/resume/template/data";
import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { useMemo } from "react";
import { templates } from "@/dialogs/resume/template/data";

type TemplateItemProps = {
	metadata: TemplateMetadata;
};

type TemplateMarqueeItem = {
	id: string;
	metadata: TemplateMetadata;
};

function TemplateItem({ metadata }: TemplateItemProps) {
	return (
		<m.div
			className="group relative shrink-0 will-change-transform"
			initial={{ scale: 1, zIndex: 10 }}
			whileHover={{ scale: 1.05, zIndex: 20 }}
			whileTap={{ scale: 0.98 }}
			transition={{ type: "spring", stiffness: 350, damping: 28 }}
		>
			<div className="relative aspect-page w-52 overflow-hidden rounded-lg border border-white/10 bg-card shadow-xl ring-1 ring-white/5 transition-all duration-300 group-hover:shadow-2xl group-hover:shadow-primary/10 sm:w-60 md:w-68 lg:w-76">
				<img
					src={metadata.imageUrl}
					alt={metadata.name}
					className="size-full object-cover"
					loading="lazy"
					style={{ imageRendering: "auto" }}
				/>

				{/* Subtle overlay on hover */}
				<div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/25 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

				{/* Template name on hover */}
				<div className="absolute inset-x-0 bottom-0 translate-y-full p-4 transition-transform duration-300 group-hover:translate-y-0">
					<p className="font-semibold text-sm text-white drop-shadow-lg">{metadata.name}</p>
				</div>

				{/* Shine effect on hover */}
				<div className="pointer-events-none absolute inset-0 -translate-x-full rotate-12 bg-linear-to-r from-transparent via-white/8 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
			</div>
		</m.div>
	);
}

type MarqueeRowProps = {
	templates: TemplateMarqueeItem[];
	direction: "left" | "right";
	duration?: number;
};

function MarqueeRow({ templates, direction, duration = 60 }: MarqueeRowProps) {
	const animateX = direction === "left" ? ["0%", "-50%"] : ["-50%", "0%"];

	return (
		<m.div
			className="flex gap-x-5 will-change-transform sm:gap-x-7"
			animate={{ x: animateX }}
			transition={{
				x: {
					repeat: Number.POSITIVE_INFINITY,
					repeatType: "loop",
					duration,
					ease: "linear",
				},
			}}
		>
			{templates.map(({ id, metadata }) => (
				<TemplateItem key={id} metadata={metadata} />
			))}
		</m.div>
	);
}

const createMarqueeItems = (entries: Array<[string, TemplateMetadata]>, rowId: string): TemplateMarqueeItem[] =>
	entries.flatMap(([template, metadata]) => [
		{ id: `${rowId}-${template}-primary`, metadata },
		{ id: `${rowId}-${template}-repeat`, metadata },
	]);

export function Templates() {
	// Split templates into two rows and duplicate for seamless infinite scroll
	const { row1, row2 } = useMemo(() => {
		const entries = Object.entries(templates);
		const half = Math.ceil(entries.length / 2);
		const firstHalf = entries.slice(0, half);
		const secondHalf = entries.slice(half);

		// Duplicate each row for seamless scrolling
		return {
			row1: createMarqueeItems(firstHalf, "row1"),
			row2: createMarqueeItems(secondHalf, "row2"),
		};
	}, []);

	return (
		<section id="templates" className="overflow-hidden border-t-0! py-16 md:py-24">
			<m.div
				className="space-y-3 px-4 will-change-[transform,opacity] md:px-8"
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.4 }}
			>
				<h2 className="font-semibold text-2xl tracking-tight md:text-4xl xl:text-5xl">
					<Trans>Premium Templates</Trans>
				</h2>

				<p className="max-w-xl text-muted-foreground leading-relaxed">
					<Trans>Professionally designed templates that make your resume stand out to recruiters.</Trans>
				</p>
			</m.div>

			<div className="relative mt-12 -rotate-3 py-8 sm:-rotate-4 lg:mt-14 lg:-rotate-5">
				{/* Edge fade masks for cinematic look */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-linear-to-r from-background to-transparent"
				/>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-linear-to-l from-background to-transparent"
				/>

				{/* Marquee container */}
				<div className="flex min-h-[300px] flex-col gap-y-5 sm:min-h-[340px] sm:gap-y-7 md:min-h-[400px] lg:min-h-[440px]">
					{/* First row - moves left to right */}
					<MarqueeRow templates={row1} direction="left" duration={80} />

					{/* Second row - moves right to left (opposite direction) */}
					<MarqueeRow templates={row2} direction="right" duration={90} />
				</div>
			</div>
		</section>
	);
}
