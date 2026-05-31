import type { AtsCheckResult } from "@reactive-resume/schema/resume/ats-check";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ArrowCounterClockwiseIcon,
	ChartBarIcon,
	CheckCircleIcon,
	FileIcon,
	LightbulbIcon,
	MagnifyingGlassIcon,
	RocketLaunchIcon,
	TargetIcon,
	UploadSimpleIcon,
	WarningCircleIcon,
	XCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@reactive-resume/ui/components/card";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Progress } from "@reactive-resume/ui/components/progress";
import { Separator } from "@reactive-resume/ui/components/separator";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { cn } from "@reactive-resume/utils/style";
import { Combobox } from "@/components/ui/combobox";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { client, orpc } from "@/libs/orpc/client";
import { DashboardHeader } from "../-components/header";

export const Route = createFileRoute("/dashboard/ats-checker/")({
	component: AtsCheckerPage,
});

type ResumeSource = "saved" | "upload";

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.split(",")[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function AtsCheckerPage() {
	const [resumeSource, setResumeSource] = useState<ResumeSource>("saved");
	const [resumeId, setResumeId] = useState<string>("");
	const [uploadedFile, setUploadedFile] = useState<File | null>(null);
	const [jobDescription, setJobDescription] = useState("");
	const [companyName, setCompanyName] = useState("");
	const [result, setResult] = useState<AtsCheckResult | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const { data: resumes, isLoading: isLoadingResumes } = useQuery(
		orpc.resume.list.queryOptions({ input: { tags: [], sort: "lastUpdatedAt" } }),
	);

	const { mutateAsync: importResume } = useMutation(orpc.resume.import.mutationOptions());

	const resumeOptions = (resumes ?? []).map((r) => ({
		value: r.id,
		label: r.name,
	}));

	const hasResumeInput = resumeSource === "saved" ? !!resumeId : !!uploadedFile;
	const hasJobDescription = jobDescription.trim().length > 10;
	const canAnalyze = hasResumeInput && hasJobDescription;

	const { mutate: runAnalysis, isPending: isAnalyzing } = useMutation({
		mutationFn: async () => {
			let targetResumeId = resumeId;

			// If user uploaded a file, first parse and import it
			if (resumeSource === "upload" && uploadedFile) {
				console.log("[ATS] UPLOAD_STARTED | file:", uploadedFile.name);
				toast.loading(t`Analyzing uploaded resume…`, { id: "ats-progress" });

				const base64 = await fileToBase64(uploadedFile);
				console.log("[ATS] UPLOAD_SUCCESS | base64 length:", base64.length);

				console.log("[ATS] GEMINI_REQUEST | parsing resume...");
				const data = await client.ai.parsePdf({
					file: { name: uploadedFile.name, data: base64 },
					mediaType: uploadedFile.type,
				});
				console.log("[ATS] TEXT_EXTRACTED | resume parsed");

				toast.loading(t`Importing resume data…`, { id: "ats-progress" });
				let importedName = "Imported Resume";
				if (uploadedFile?.name) {
					const extIndex = uploadedFile.name.lastIndexOf(".");
					importedName = extIndex !== -1 ? uploadedFile.name.substring(0, extIndex) : uploadedFile.name;
				}
				targetResumeId = await importResume({ data, name: importedName });
				console.log("[ATS] SAVE_SUCCESS | imported resumeId:", targetResumeId);
			}

			if (!targetResumeId) {
				throw new Error("No resume selected or imported.");
			}

			toast.loading(t`Running ATS analysis…`, { id: "ats-progress" });
			console.log("[ATS] GEMINI_REQUEST | running ATS check...");

			return client.ai.atsCheck({
				resumeId: targetResumeId,
				jobDescription,
				companyName: companyName || undefined,
			});
		},
		onSuccess: (data) => {
			console.log("[ATS] SAVE_SUCCESS | ATS score:", data.score);
			setResult(data);
			toast.success(t`ATS analysis completed successfully.`, { id: "ats-progress" });
		},
		onError: (error) => {
			console.error("[ATS] GEMINI_FAILED |", error);
			toast.error(
				getOrpcErrorMessage(error, {
					allowServerMessage: true,
					byCode: {
						BAD_GATEWAY: t`Could not reach the AI provider. Please try again.`,
						BAD_REQUEST: t`The AI returned an invalid analysis. Please try again.`,
						PRECONDITION_FAILED: t`AI providers are unavailable. Please configure ENCRYPTION_SECRET in your environment.`,
						TOO_MANY_REQUESTS: t`AI quota exceeded. Please wait a minute and try again.`,
					},
					fallback: t`Analysis failed. Make sure you have an AI provider configured in Settings → AI Providers.`,
				}),
				{ id: "ats-progress" },
			);
		},
	});

	const onAnalyze = useCallback(() => {
		if (!canAnalyze || isAnalyzing) return;
		runAnalysis();
	}, [canAnalyze, isAnalyzing, runAnalysis]);

	const onReset = useCallback(() => {
		setResult(null);
		setJobDescription("");
		setCompanyName("");
		setUploadedFile(null);
		setResumeId("");
	}, []);

	const onSelectFile = () => {
		fileInputRef.current?.click();
	};

	const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) setUploadedFile(file);
	};

	return (
		<div className="space-y-6">
			<DashboardHeader icon={ChartBarIcon} title={t`ATS Score Checker`} />
			<Separator />

			{!result ? (
				<div className="mx-auto max-w-2xl space-y-6">
					{/* Resume Source Toggle */}
					<div className="space-y-2">
						<Label>
							<Trans>Resume</Trans>
						</Label>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant={resumeSource === "saved" ? "default" : "outline"}
								onClick={() => {
									setResumeSource("saved");
									setUploadedFile(null);
								}}
							>
								<Trans>Select Saved Resume</Trans>
							</Button>
							<Button
								size="sm"
								variant={resumeSource === "upload" ? "default" : "outline"}
								onClick={() => {
									setResumeSource("upload");
									setResumeId("");
								}}
							>
								<UploadSimpleIcon className="size-4" />
								<Trans>Upload from Device</Trans>
							</Button>
						</div>
					</div>

					{/* Resume Input: Saved */}
					{resumeSource === "saved" && (
						<div className="space-y-2">
							{isLoadingResumes ? (
								<div className="flex items-center gap-2 text-muted-foreground text-sm">
									<Spinner />
									<Trans>Loading resumes…</Trans>
								</div>
							) : (
								<Combobox
									value={resumeId}
									options={resumeOptions}
									placeholder={t`Choose a resume to analyze…`}
									onValueChange={(val) => setResumeId(val ?? "")}
								/>
							)}
						</div>
					)}

					{/* Resume Input: Upload */}
					{resumeSource === "upload" && (
						<div className="space-y-2">
							<Input
								type="file"
								className="hidden"
								ref={fileInputRef}
								accept="application/pdf,image/png,image/jpeg,image/jpg,image/webp"
								onChange={onFileChange}
							/>
							<Button
								variant="outline"
								className="h-auto w-full flex-col border-dashed py-8 font-normal"
								onClick={onSelectFile}
							>
								{uploadedFile ? (
									<>
										<FileIcon weight="thin" size={32} />
										<p>{uploadedFile.name}</p>
									</>
								) : (
									<>
										<UploadSimpleIcon weight="thin" size={32} />
										<Trans>Click to upload PDF, PNG, or JPEG</Trans>
									</>
								)}
							</Button>
							{uploadedFile && resumeSource === "upload" && (
								<p className="text-muted-foreground text-xs">
									<Trans>The uploaded resume will be parsed by AI and saved to your dashboard before analysis.</Trans>
								</p>
							)}
						</div>
					)}

					{/* Job Description */}
					<div className="space-y-2">
						<Label>
							<Trans>Job Description</Trans>
						</Label>
						<Textarea
							rows={10}
							value={jobDescription}
							placeholder={t`Paste the full job description here…`}
							onChange={(e) => setJobDescription(e.target.value)}
							className="resize-y"
						/>
						<p className="text-muted-foreground text-xs">
							<Trans>Paste the complete job posting for the most accurate analysis.</Trans>
						</p>
					</div>

					{/* Company Name */}
					<div className="space-y-2">
						<Label>
							<Trans>Company Name (optional)</Trans>
						</Label>
						<Textarea
							rows={1}
							value={companyName}
							placeholder={t`e.g. Google, Microsoft…`}
							onChange={(e) => setCompanyName(e.target.value)}
						/>
					</div>

					{/* Analyze Button */}
					<Button className="w-full" size="lg" disabled={!canAnalyze || isAnalyzing} onClick={onAnalyze}>
						{isAnalyzing ? (
							<>
								<Spinner />
								<Trans>Analyzing resume…</Trans>
							</>
						) : (
							<>
								<MagnifyingGlassIcon className="size-4" />
								<Trans>Analyze ATS Compatibility</Trans>
							</>
						)}
					</Button>
				</div>
			) : (
				<AtsResults result={result} onReset={onReset} />
			)}
		</div>
	);
}

// --- Results Components ---

function AtsResults({ result, onReset }: { result: AtsCheckResult; onReset: () => void }) {
	return (
		<div className="space-y-6">
			{/* Top Row: Score + Recommendation */}
			<div className="grid gap-4 sm:grid-cols-2">
				<ScoreCard score={result.score} />
				<RecommendationCard recommendation={result.recommendation} />
			</div>

			{/* Keyword Analysis */}
			<KeywordAnalysisCard matched={result.keywordAnalysis.matched} missing={result.keywordAnalysis.missing} />

			{/* Section Analysis */}
			<SectionAnalysisCard sections={result.sectionAnalysis} />

			{/* Suggestions */}
			<SuggestionsCard suggestions={result.suggestions} />

			{/* Suggested Projects */}
			{result.suggestedProjects.length > 0 && <SuggestedProjectsCard projects={result.suggestedProjects} />}

			{/* Power Words */}
			{result.powerWords.length > 0 && <PowerWordsCard words={result.powerWords} />}

			{/* Reset Button */}
			<div className="flex justify-center pt-2">
				<Button variant="outline" onClick={onReset}>
					<ArrowCounterClockwiseIcon className="size-4" />
					<Trans>Analyze Another Resume</Trans>
				</Button>
			</div>
		</div>
	);
}

function ScoreCard({ score }: { score: number }) {
	const color = score >= 75 ? "text-emerald-400" : score >= 50 ? "text-amber-400" : "text-red-400";

	const bgRing =
		score >= 75
			? "from-emerald-500/20 to-emerald-500/5"
			: score >= 50
				? "from-amber-500/20 to-amber-500/5"
				: "from-red-500/20 to-red-500/5";

	return (
		<Card className="border border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<TargetIcon className="size-5" />
					<Trans>ATS Score</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex items-center justify-center pb-6">
				<div className="relative flex size-32 items-center justify-center">
					<svg
						className="absolute inset-0 size-full -rotate-90 transform"
						viewBox="0 0 100 100"
						aria-label="ATS Score Progress"
					>
						<title>ATS Score Progress</title>
						<circle className="stroke-white/10" cx="50" cy="50" r="45" fill="none" strokeWidth="8" />
						<circle
							className={cn("transition-all duration-1000 ease-out", color.replace("text-", "stroke-"))}
							cx="50"
							cy="50"
							r="45"
							fill="none"
							strokeWidth="8"
							strokeDasharray="283"
							strokeDashoffset={283 - (283 * score) / 100}
							strokeLinecap="round"
						/>
					</svg>
					<div
						className={cn(
							"flex size-24 flex-col items-center justify-center rounded-full bg-gradient-to-b shadow-inner",
							bgRing,
						)}
					>
						<span className={cn("font-bold text-4xl tabular-nums tracking-tighter", color)}>{score}</span>
						<span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">/100</span>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function RecommendationCard({ recommendation }: { recommendation: AtsCheckResult["recommendation"] }) {
	const config = {
		high_chance: {
			label: t`High Chance`,
			description: t`Your resume is well-aligned with this role.`,
			icon: <CheckCircleIcon weight="fill" className="size-6 text-emerald-400" />,
			border: "border-emerald-500/30",
			bg: "bg-emerald-500/5",
		},
		medium_chance: {
			label: t`Medium Chance`,
			description: t`Your resume has potential but needs some improvements.`,
			icon: <WarningCircleIcon weight="fill" className="size-6 text-amber-400" />,
			border: "border-amber-500/30",
			bg: "bg-amber-500/5",
		},
		needs_improvement: {
			label: t`Needs Improvement`,
			description: t`Significant changes recommended for this role.`,
			icon: <XCircleIcon weight="fill" className="size-6 text-red-400" />,
			border: "border-red-500/30",
			bg: "bg-red-500/5",
		},
	}[recommendation];

	return (
		<Card
			className={cn(
				"border bg-white/5 shadow-xl backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:bg-white/10 dark:bg-black/20",
				config.border,
			)}
		>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<RocketLaunchIcon className="size-5" />
					<Trans>Recommendation</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className={cn("flex items-center gap-4 rounded-b-xl p-6", config.bg)}>
				<div className="shrink-0">{config.icon}</div>
				<div className="space-y-1">
					<p className="font-semibold tracking-tight">{config.label}</p>
					<p className="text-muted-foreground text-sm leading-relaxed">{config.description}</p>
				</div>
			</CardContent>
		</Card>
	);
}

function KeywordAnalysisCard({ matched, missing }: { matched: string[]; missing: string[] }) {
	return (
		<Card className="border border-white/10 bg-white/5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<MagnifyingGlassIcon className="size-5" />
					<Trans>Keyword Analysis</Trans>
				</CardTitle>
				<CardDescription className="font-medium text-sm">
					<Trans>
						{matched.length} matched · {missing.length} missing
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{matched.length > 0 && (
					<div className="space-y-2">
						<p className="font-medium text-emerald-400 text-sm">
							<Trans>Matched Keywords</Trans>
						</p>
						<div className="flex flex-wrap gap-1.5">
							{matched.map((kw) => (
								<Badge key={kw} className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
									{kw}
								</Badge>
							))}
						</div>
					</div>
				)}
				{missing.length > 0 && (
					<div className="space-y-2">
						<p className="font-medium text-red-400 text-sm">
							<Trans>Missing Keywords</Trans>
						</p>
						<div className="flex flex-wrap gap-1.5">
							{missing.map((kw) => (
								<Badge key={kw} className="border-red-500/30 bg-red-500/10 text-red-300">
									{kw}
								</Badge>
							))}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function SectionAnalysisCard({ sections }: { sections: AtsCheckResult["sectionAnalysis"] }) {
	return (
		<Card className="border border-white/10 bg-white/5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<ChartBarIcon className="size-5" />
					<Trans>Section Analysis</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-6 sm:grid-cols-2">
				{sections.map((s) => (
					<div key={s.section} className="space-y-1.5">
						<div className="flex items-center justify-between">
							<span className="font-medium text-sm">{s.section}</span>
							<span
								className={cn(
									"font-semibold text-sm tabular-nums",
									s.score >= 75 ? "text-emerald-400" : s.score >= 50 ? "text-amber-400" : "text-red-400",
								)}
							>
								{s.score}/100
							</span>
						</div>
						<Progress value={s.score} className="h-2" />
						<p className="text-muted-foreground text-xs leading-relaxed">{s.feedback}</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function SuggestionsCard({ suggestions }: { suggestions: AtsCheckResult["suggestions"] }) {
	const impactColor = {
		high: "border-red-500/40 bg-red-500/20 text-red-200",
		medium: "border-amber-500/40 bg-amber-500/20 text-amber-200",
		low: "border-blue-500/40 bg-blue-500/20 text-blue-200",
	};

	return (
		<Card className="border border-white/10 bg-white/5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<LightbulbIcon className="size-5 text-amber-400" />
					<Trans>Improvement Suggestions</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-4 sm:grid-cols-2">
				{suggestions.map((s, i) => (
					<div key={i} className="space-y-1 rounded-lg border border-border/50 p-3">
						<div className="flex items-center gap-2">
							<span className="font-medium text-sm">{s.title}</span>
							<Badge className={cn("text-[0.65rem] uppercase", impactColor[s.impact])}>{s.impact}</Badge>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">{s.description}</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function SuggestedProjectsCard({ projects }: { projects: AtsCheckResult["suggestedProjects"] }) {
	return (
		<Card className="border border-white/10 bg-white/5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<RocketLaunchIcon className="size-5 text-purple-400" />
					<Trans>Suggested Projects</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Project ideas to strengthen your resume for this role</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4 sm:grid-cols-2">
				{projects.map((p, i) => (
					<div key={i} className="space-y-1 rounded-lg border border-border/50 p-3">
						<p className="font-medium text-sm">{p.title}</p>
						<p className="text-muted-foreground text-xs leading-relaxed">{p.description}</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function PowerWordsCard({ words }: { words: string[] }) {
	return (
		<Card className="border border-white/10 bg-white/5 shadow-lg backdrop-blur-xl transition-all duration-300 hover:bg-white/10 dark:border-white/5 dark:bg-black/20">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 font-semibold text-base tracking-tight">
					<LightbulbIcon className="size-5 text-amber-400" />
					<Trans>Power Words</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Strong action verbs and keywords to incorporate</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex flex-wrap gap-1.5">
					{words.map((w) => (
						<Badge key={w} className="border-primary/30 bg-primary/10 text-primary">
							{w}
						</Badge>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
