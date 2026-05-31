import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { DialogProps } from "../store";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DownloadSimpleIcon, FileIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import z from "zod";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import {
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { FormControl, FormItem, FormLabel, FormMessage } from "@reactive-resume/ui/components/form";
import { Input } from "@reactive-resume/ui/components/input";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { cn } from "@reactive-resume/utils/style";
import { Combobox } from "@/components/ui/combobox";
import { useFormBlocker } from "@/hooks/use-form-blocker";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { client, orpc } from "@/libs/orpc/client";
import { useAppForm } from "@/libs/tanstack-form";
import { useDialogStore } from "../store";

const formSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal(""),
		file: z.undefined(),
	}),
	z.object({
		type: z.literal("pdf"),
		file: z.instanceof(File).refine((file) => file.type === "application/pdf", { message: "File must be a PDF" }),
	}),
	z.object({
		type: z.literal("image"),
		file: z.instanceof(File).refine((file) => file.type.startsWith("image/"), { message: "File must be an image" }),
	}),
]);

type FormValues = z.infer<typeof formSchema>;
type ImportType = FormValues["type"];

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			// remove data URL prefix (e.g., "data:application/pdf;base64," or "data:application/vnd...;base64,")
			resolve(result.split(",")[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

const LOADING_STEPS = [
	() => t`Analyzing your resume…`,
	() => t`Extracting content…`,
	() => t`Creating editable resume…`,
];

export function ImportResumeDialog(_: DialogProps<"resume.import">) {
	const navigate = useNavigate();
	const closeDialog = useDialogStore((state) => state.closeDialog);

	const prevTypeRef = useRef<string>("");
	const inputRef = useRef<HTMLInputElement>(null);
	const [isImporting, setIsImporting] = useState<boolean>(false);
	const [loadingStep, setLoadingStep] = useState(0);

	const { mutateAsync: importResume } = useMutation(orpc.resume.import.mutationOptions());

	const form = useAppForm({
		defaultValues: {
			type: "" as ImportType,
			file: undefined as File | undefined,
		},
		validators: { onSubmit: formSchema },
		onSubmit: async ({ value }) => {
			if (value.type === "" || !value.file) return;

			setIsImporting(true);
			setLoadingStep(0);

			const toastId = toast.loading(t`Analyzing your resume…`, {
				description: t`Please do not close the window or refresh the page.`,
			});

			try {
				let data: ResumeData | undefined;

				if (value.type === "pdf" || value.type === "image") {
					// Step 1: Analyzing
					setLoadingStep(0);
					console.log("[IMPORT] UPLOAD_STARTED | type:", value.type, "| file:", value.file.name);

					const base64 = await fileToBase64(value.file);
					console.log("[IMPORT] UPLOAD_SUCCESS | base64 length:", base64.length);

					// Step 2: Extracting
					setLoadingStep(1);
					toast.loading(t`Extracting content…`, { id: toastId, description: null });

					console.log("[IMPORT] GEMINI_REQUEST | sending to AI...");
					data = await client.ai.parsePdf({
						file: { name: value.file.name, data: base64 },
						mediaType: value.file.type,
					});
					console.log("[IMPORT] TEXT_EXTRACTED | data received");
				}

				if (!data) {
					throw new Error(
						t({
							comment: "Error shown when AI import endpoint returns no parsed resume data",
							message: "No data was returned from the AI provider.",
						}),
					);
				}

				// Step 3: Creating
				setLoadingStep(2);
				toast.loading(t`Creating editable resume…`, { id: toastId, description: null });

				let importedName = "Imported Resume";
				if (value.file?.name) {
					const extIndex = value.file.name.lastIndexOf(".");
					importedName = extIndex !== -1 ? value.file.name.substring(0, extIndex) : value.file.name;
				}

				const id = await importResume({ data, name: importedName });
				console.log("[IMPORT] SAVE_SUCCESS | resumeId:", id);
				toast.success(t`Your resume has been imported successfully.`, { id: toastId, description: null });
				closeDialog();
				void navigate({ to: "/builder/$resumeId", params: { resumeId: id } });
			} catch (error: unknown) {
				console.error("[IMPORT] GEMINI_FAILED |", error);
				toast.error(
					getOrpcErrorMessage(error, {
						allowServerMessage: true,
						byCode: {
							BAD_REQUEST: t({
								comment: "Error shown when AI parsing returns invalid resume structure during import",
								message: "The imported file could not be parsed into a valid resume.",
							}),
							BAD_GATEWAY: t({
								comment: "Error shown when AI provider is unreachable during PDF/DOCX resume import",
								message: "Could not reach the AI provider. Please try again.",
							}),
							PRECONDITION_FAILED: t({
								comment: "Error shown when ENCRYPTION_SECRET is not configured",
								message: "AI providers are unavailable. Please configure ENCRYPTION_SECRET in your environment.",
							}),
							TOO_MANY_REQUESTS: t({
								comment: "Error shown when Gemini quota is exceeded during import",
								message: "AI quota exceeded. Please wait a minute and try again.",
							}),
						},
						fallback: t({
							comment: "Fallback toast when importing a resume fails for an unknown reason",
							message: "Import failed. Make sure you have an AI provider configured in Settings → AI Providers.",
						}),
					}),
					{ id: toastId, description: null },
				);
			} finally {
				setIsImporting(false);
				setLoadingStep(0);
			}
		},
	});

	const type = useStore(form.store, (s) => s.values.type);

	useEffect(() => {
		if (prevTypeRef.current === type) return;
		prevTypeRef.current = type;
		form.setFieldValue("file", undefined);
	}, [form, type]);

	const acceptMap: Record<string, string> = {
		pdf: "application/pdf",
		image: "image/png,image/jpeg,image/jpg,image/webp",
	};

	const onSelectFile = () => {
		if (!inputRef.current) return;

		// Set accept attribute based on selected type
		if (type && acceptMap[type]) {
			inputRef.current.accept = acceptMap[type];
		}

		inputRef.current.click();
	};

	const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		form.setFieldValue("file", file);
	};

	useFormBlocker(form);

	const loadingMessage = isImporting ? (LOADING_STEPS[loadingStep]?.() ?? t`Importing…`) : t`Import`;

	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-x-2">
					<DownloadSimpleIcon />
					<Trans>Import an existing resume</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>
						Upload a PDF or image (PNG, JPEG) of your resume. AI will extract the content and create an editable resume
						you can customize.
					</Trans>
				</DialogDescription>
			</DialogHeader>

			<form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<form.Field name="type">
					{(field) => (
						<FormItem hasError={field.state.meta.isTouched && field.state.meta.errors.length > 0}>
							<FormLabel>
								<Trans>File Type</Trans>
							</FormLabel>
							<FormControl
								render={
									<Combobox
										showClear={false}
										value={field.state.value}
										onValueChange={(value) => {
											field.handleChange(value as ImportType);
										}}
										options={[
											{
												value: "pdf",
												label: (
													<div className="flex items-center gap-x-2">
														{t({
															comment: "File format label in import source selector",
															message: "PDF",
														})}{" "}
														<Badge>{t`AI`}</Badge>
													</div>
												),
											},
											{
												value: "image",
												label: (
													<div className="flex items-center gap-x-2">
														{t({
															comment: "File format label in import source selector",
															message: "Image (PNG, JPEG)",
														})}{" "}
														<Badge>{t`AI`}</Badge>
													</div>
												),
											},
										]}
									/>
								}
							/>
							<FormMessage errors={field.state.meta.errors} />
						</FormItem>
					)}
				</form.Field>

				<form.Field key={type} name="file">
					{(field) => (
						<FormItem
							className={cn(!type && "hidden")}
							hasError={field.state.meta.isTouched && field.state.meta.errors.length > 0}
						>
							<FormControl>
								<Input type="file" className="hidden" ref={inputRef} onChange={onUploadFile} />

								<Button
									variant="outline"
									className="h-auto w-full flex-col border-dashed py-8 font-normal"
									onClick={onSelectFile}
								>
									{field.state.value ? (
										<>
											<FileIcon weight="thin" size={32} />
											<p>{field.state.value.name}</p>
										</>
									) : (
										<>
											<UploadSimpleIcon weight="thin" size={32} />
											<Trans>Click here to select a file to import</Trans>
										</>
									)}
								</Button>
							</FormControl>
							<FormMessage errors={field.state.meta.errors} />
						</FormItem>
					)}
				</form.Field>

				<DialogFooter>
					<Button type="submit" disabled={!type || isImporting}>
						{isImporting ? <Spinner /> : null}
						{loadingMessage}
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
