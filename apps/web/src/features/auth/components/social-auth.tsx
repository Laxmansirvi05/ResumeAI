import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { GoogleLogoIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { authClient } from "@/libs/auth/client";
import { orpc } from "@/libs/orpc/client";

type SocialAuthProps = {
	requestSignUp?: boolean;
};

type SocialSignInOptions = {
	provider: string;
	callbackURL: string;
	requestSignUp?: true;
};

function getSocialSignInOptions(provider: string, requestSignUp: boolean): SocialSignInOptions {
	const options: SocialSignInOptions = { provider, callbackURL: "/dashboard" };
	if (requestSignUp) options.requestSignUp = true;
	return options;
}

export function SocialAuth({ requestSignUp = false }: SocialAuthProps) {
	const { isLoading } = useQuery(orpc.auth.providers.list.queryOptions());

	return (
		<>
			<div className="my-6 flex items-center gap-x-2">
				<hr className="flex-1" />
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
					<Trans context="Choose to authenticate with a social provider (Google, GitHub, etc.) instead of email and password">
						or
					</Trans>
				</span>
				<hr className="flex-1" />
			</div>

			{isLoading ? <SocialAuthSkeleton /> : <SocialAuthButtons requestSignUp={requestSignUp} />}
		</>
	);
}

function SocialAuthSkeleton() {
	return <Skeleton className="h-9 w-full" />;
}

type SocialAuthButtonsProps = {
	requestSignUp: boolean;
};

function SocialAuthButtons({ requestSignUp }: SocialAuthButtonsProps) {
	const router = useRouter();

	const handleSocialLogin = async (provider: string) => {
		const toastId = toast.loading(t`Signing in...`);

		const { error } = await authClient.signIn.social(getSocialSignInOptions(provider, requestSignUp));

		if (error) {
			toast.error(
				error.message ||
					t({
						comment: "Fallback toast when social sign-in fails without a provider error message",
						message: "Failed to sign in. Please try again.",
					}),
				{ id: toastId },
			);
			return;
		}

		toast.dismiss(toastId);
		await router.invalidate();
	};

	return (
		<div className="flex flex-col gap-4">
			<Button
				onClick={() => handleSocialLogin("google")}
				className="w-full border bg-white text-black hover:bg-white/90 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800"
			>
				<GoogleLogoIcon weight="fill" className="mr-2 size-5" />
				<Trans comment="Brand name label for Google social sign-in button">Continue with Google</Trans>
			</Button>
		</div>
	);
}
