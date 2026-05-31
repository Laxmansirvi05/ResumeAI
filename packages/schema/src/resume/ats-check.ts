import z from "zod";

export const atsKeywordAnalysisSchema = z.object({
	matched: z.array(z.string()).describe("Keywords from the job description that are present in the resume."),
	missing: z.array(z.string()).describe("Keywords from the job description that are missing from the resume."),
});

export const atsSectionAnalysisSchema = z.object({
	section: z.string().min(1).describe("The name of the resume section analyzed."),
	score: z.number().int().min(0).max(100).describe("Score for this section out of 100."),
	feedback: z.string().min(1).describe("Specific feedback for this section."),
});

export const atsSuggestionSchema = z.object({
	title: z.string().min(1).describe("Short title of the suggestion."),
	description: z.string().min(1).describe("Detailed actionable description."),
	impact: z.enum(["high", "medium", "low"]).describe("Expected impact level of this suggestion."),
});

export const atsSuggestedProjectSchema = z.object({
	title: z.string().min(1).describe("Suggested project title."),
	description: z.string().min(1).describe("Brief description of the project and why it would help."),
});

export const atsRecommendationSchema = z.enum(["high_chance", "medium_chance", "needs_improvement"]);

export const atsCheckResultSchema = z.object({
	score: z.number().int().min(0).max(100).describe("Overall ATS compatibility score."),
	keywordAnalysis: atsKeywordAnalysisSchema.describe("Keyword match analysis against the job description."),
	sectionAnalysis: z.array(atsSectionAnalysisSchema).describe("Per-section analysis of the resume."),
	suggestions: z.array(atsSuggestionSchema).max(10).describe("Actionable improvement suggestions."),
	suggestedProjects: z
		.array(atsSuggestedProjectSchema)
		.max(5)
		.describe("Project ideas that would strengthen the resume for this role."),
	powerWords: z.array(z.string()).max(20).describe("Powerful action verbs and keywords to use."),
	recommendation: atsRecommendationSchema.describe("Overall recommendation level."),
});

export const atsCheckOutputSchema = z.object({
	score: z.number(),
	keywordAnalysis: z.object({
		matched: z.array(z.string()),
		missing: z.array(z.string()),
	}),
	sectionAnalysis: z.array(
		z.object({
			section: z.string(),
			score: z.number(),
			feedback: z.string(),
		}),
	),
	suggestions: z.array(
		z.object({
			title: z.string(),
			description: z.string(),
			impact: z.enum(["high", "medium", "low"]),
		}),
	),
	suggestedProjects: z.array(
		z.object({
			title: z.string(),
			description: z.string(),
		}),
	),
	powerWords: z.array(z.string()),
	recommendation: z.enum(["high_chance", "medium_chance", "needs_improvement"]),
});

export type AtsCheckResult = z.infer<typeof atsCheckResultSchema>;
export type AtsRecommendation = z.infer<typeof atsRecommendationSchema>;
