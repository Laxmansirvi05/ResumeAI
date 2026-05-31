import { Outlet } from "@tanstack/react-router";
import { BrandIcon } from "@reactive-resume/ui/components/brand-icon";

export function AuthLayout() {
	return (
		<div className="flex min-h-svh w-dvw flex-col items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
			<div className="w-full max-w-[420px] rounded-3xl border border-zinc-200 bg-white p-8 shadow-2xl backdrop-blur-xl sm:p-10 dark:border-zinc-800 dark:bg-zinc-900/50">
				<div className="mb-6 flex justify-center">
					<BrandIcon className="size-16" />
				</div>
				<Outlet />
			</div>
		</div>
	);
}
