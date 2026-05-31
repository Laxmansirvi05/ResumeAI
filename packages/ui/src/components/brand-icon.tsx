import { cn } from "@reactive-resume/utils/style";

type Props = React.ComponentProps<"span"> & {
	variant?: "logo" | "icon";
};

export function BrandIcon({ variant = "logo", className, ...props }: Props) {
	if (variant === "icon") {
		return (
			<span className={cn("font-bold text-primary tracking-tighter", className)} {...props}>
				R-AI
			</span>
		);
	}
	return (
		<span className={cn("font-bold text-primary text-xl tracking-tighter", className)} {...props}>
			ResumeAI
		</span>
	);
}
