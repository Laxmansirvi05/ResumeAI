import { m } from "motion/react";
import { BrandIcon } from "@reactive-resume/ui/components/brand-icon";

export function Footer() {
	const year = new Date().getFullYear();

	return (
		<m.footer
			id="footer"
			className="flex flex-col items-center justify-center gap-y-4 p-6 pb-10 will-change-[opacity] md:flex-row md:justify-between md:p-8 md:pb-12"
			initial={{ opacity: 0 }}
			whileInView={{ opacity: 1 }}
			viewport={{ once: true }}
			transition={{ duration: 0.45 }}
		>
			<div className="flex items-center gap-x-3">
				<BrandIcon variant="logo" className="size-6" />
				<span className="text-muted-foreground text-sm">&copy; {year}</span>
			</div>
		</m.footer>
	);
}
