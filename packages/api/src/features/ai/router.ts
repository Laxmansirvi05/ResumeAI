import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { UIMessage } from "ai";
import { ORPCError } from "@orpc/client";
import { type } from "@orpc/server";
import { AISDKError } from "ai";
import { flattenError, ZodError, z } from "zod";
import { storedResumeAnalysisSchema } from "@reactive-resume/schema/resume/analysis";
import { atsCheckResultSchema } from "@reactive-resume/schema/resume/ats-check";
import { protectedProcedure } from "../../context";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { aiProvidersService } from "../ai-providers/service";
import { resumeService } from "../resume/service";
import { aiService, fileInputSchema } from "./service";

function isInvalidAiBaseUrlError(error: unknown): boolean {
	return error instanceof Error && error.message === "INVALID_AI_BASE_URL";
}

function isAiQuotaError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const isResourceExhausted = (error as Record<string, unknown>)?.data?.error?.status === "RESOURCE_EXHAUSTED";
	const is429 = error?.statusCode === 429;
	const hasQuotaMetric = error?.message?.includes("quotaMetric") || JSON.stringify(error).includes("quotaMetric");
	return isResourceExhausted || is429 || hasQuotaMetric;
}

function isAiProviderGatewayError(error: unknown): boolean {
	// AISDKError covers structured errors from the AI SDK
	if (error instanceof AISDKError) return true;
	// Catch Google API errors that are not AISDKError instances
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		const name = error.name.toLowerCase();
		// Google GenerativeAI API errors
		if (name.includes("google") || name.includes("generativeai")) return true;
		// HTTP/network errors from the AI provider
		if (msg.includes("api key") || msg.includes("permission denied") || msg.includes("not found")) return true;
		if (msg.includes("fetch failed") || msg.includes("econnrefused") || msg.includes("enotfound")) return true;
		if (msg.includes("invalid_argument") || msg.includes("unauthenticated")) return true;
		// HTTP status code errors from AI SDK providers
		if (msg.includes("status code") || msg.includes("response was not ok")) return true;
		// Groq-specific: invalid_request_error (e.g. unsupported content type)
		if (msg.includes("invalid_request_error") || msg.includes("not allowed")) return true;
	}
	return false;
}

function isCredentialEncryptionUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message === "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE";
}

function throwAiQuotaError(): never {
	throw new ORPCError("TOO_MANY_REQUESTS", {
		message: "Google AI Studio quota reached. Please wait 1 minute and try again.",
	});
}

function throwAiProviderGatewayError(): never {
	throw new ORPCError("BAD_GATEWAY", { message: "Could not reach the AI provider." });
}

function throwAiProviderConfigError(): never {
	throw new ORPCError("BAD_REQUEST", { message: "Invalid AI provider configuration." });
}

function throwCredentialEncryptionUnavailable(): never {
	throw new ORPCError("PRECONDITION_FAILED", {
		message: "AI providers are unavailable because ENCRYPTION_SECRET is not configured.",
	});
}

function throwResumeStructureError(error: ZodError): never {
	throw new ORPCError("BAD_REQUEST", {
		message: "Invalid resume data structure",
		cause: flattenError(error),
	});
}

function isFallbackableError(error: unknown): boolean {
	if (isAiQuotaError(error)) return true;
	if (isAiProviderGatewayError(error)) return true;
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		if (msg.includes("timeout") || msg.includes("unavailable") || msg.includes("rate limit")) return true;
	}
	return false;
}

async function getGroqFallbackProvider() {
	const { env } = await import("@reactive-resume/env/server");
	const groqKey = env.GROQ_API_KEY;
	if (!groqKey) return null;

	return {
		provider: "openai-compatible" as const,
		model: "llama-3.3-70b-versatile",
		apiKey: groqKey,
		baseURL: "https://api.groq.com/openai/v1",
	};
}

async function withAiFallback<T>(
	primaryOperation: () => Promise<T>,
	makeFallbackOperation: (provider: {
		provider: "openai-compatible";
		model: string;
		apiKey: string;
		baseURL: string;
	}) => Promise<T>,
): Promise<T> {
	try {
		return await primaryOperation();
	} catch (error: unknown) {
		// Check if this error is worth falling back for
		if (!isFallbackableError(error)) {
			throw error;
		}

		console.log("[AI] GEMINI_FAILED | error:", error instanceof Error ? error.message : error);
		console.log("[AI] FALLBACK_TO_GROQ | attempting Groq immediately...");

		const groq = await getGroqFallbackProvider();
		if (!groq) {
			console.log("[AI] GROQ_NOT_CONFIGURED | no GROQ_API_KEY in env, re-throwing original error");
			throw error;
		}

		try {
			const result = await makeFallbackOperation(groq);
			console.log("[AI] GROQ_SUCCESS | fallback completed");
			return result;
		} catch (groqError: unknown) {
			console.error("[AI] GROQ_FAILED |", groqError instanceof Error ? groqError.message : groqError);
			// Throw the Groq error since it's the most recent attempt
			throw groqError;
		}
	}
}

async function getRunnableProvider(userId: string, aiProviderId?: string) {
	// 1. Try user-configured provider from the database
	try {
		const provider = aiProviderId
			? await aiProvidersService.getRunnableById({ id: aiProviderId, userId })
			: await aiProvidersService.getDefaultRunnable({ userId });

		if (provider) return provider;
	} catch {
		// If credential encryption is unavailable or DB lookup fails, fall through to env fallback
	}

	// 2. Fall back to GOOGLE_GENERATIVE_AI_API_KEY from environment
	const { env } = await import("@reactive-resume/env/server");
	const geminiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;

	if (geminiKey) {
		return {
			id: "__env_gemini__",
			label: "Gemini (env)",
			provider: "gemini" as const,
			model: "gemini-2.0-flash",
			apiKey: geminiKey,
			baseURL: "",
			enabled: true,
			testStatus: "success",
			testError: null,
			apiKeyPreview: `${geminiKey.slice(0, 4)}...${geminiKey.slice(-4)}`,
			apiKeyFingerprint: "",
			lastTestedAt: null,
			lastUsedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	throw new ORPCError("BAD_REQUEST", {
		message:
			"No AI provider configured. Please add your Gemini API key in .env (GOOGLE_GENERATIVE_AI_API_KEY=...) or configure a provider in Settings → AI Providers.",
	});
}

export const aiRouter = {
	parsePdf: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/parse-pdf",
			tags: ["AI"],
			operationId: "parseResumePdf",
			summary: "Parse a PDF file into resume data",
			description:
				"Extracts structured resume data from a PDF file using the specified AI provider. The file should be sent as a base64-encoded string along with AI provider credentials. Returns a complete ResumeData object. Requires authentication.",
			successDescription: "The PDF was successfully parsed into structured resume data.",
		})
		.input(z.object({ aiProviderId: z.string().optional(), file: fileInputSchema, mediaType: z.string().optional() }))
		.use(aiRequestRateLimit)
		.errors({
			BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
			BAD_REQUEST: { message: "The AI returned an improperly formatted structure.", status: 400 },
			TOO_MANY_REQUESTS: {
				message: "Google AI Studio quota reached. Please wait 1 minute and try again.",
				status: 429,
			},
		})
		.handler(async ({ context, input }): Promise<ResumeData> => {
			console.log("[AI] UPLOAD_STARTED | parsePdf handler | user:", context.user.id, "| file:", input.file.name);
			try {
				const provider = await getRunnableProvider(context.user.id, input.aiProviderId);
				console.log("[AI] GEMINI_STARTED |", provider.provider, "|", provider.model);
				const result = await withAiFallback(
					() =>
						aiService.parsePdf({
							provider: provider.provider,
							model: provider.model,
							apiKey: provider.apiKey,
							baseURL: provider.baseURL ?? "",
							file: input.file,
							mediaType: input.mediaType ?? "application/pdf",
						}),
					(groq) =>
						aiService.parsePdf({
							provider: groq.provider,
							model: groq.model,
							apiKey: groq.apiKey,
							baseURL: groq.baseURL,
							file: input.file,
							mediaType: input.mediaType ?? "application/pdf",
						}),
				);
				console.log("[AI] SAVE_SUCCESS | parsePdf completed");
				return result;
			} catch (error) {
				console.error("[AI] PARSE_PDF_FAILED |", error instanceof Error ? error.message : error);
				if (error instanceof ORPCError) throw error;
				if (isAiQuotaError(error)) throwAiQuotaError();
				if (isCredentialEncryptionUnavailable(error)) throwCredentialEncryptionUnavailable();
				if (isInvalidAiBaseUrlError(error)) throwAiProviderConfigError();
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError();
				if (error instanceof ZodError) throwResumeStructureError(error);
				const message = error instanceof Error ? error.message : "An unexpected error occurred during resume parsing.";
				throw new ORPCError("BAD_GATEWAY", { message: `AI provider error: ${message}` });
			}
		}),

	parseDocx: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/parse-docx",
			tags: ["AI"],
			operationId: "parseResumeDocx",
			summary: "Parse a DOCX file into resume data",
			description:
				"Extracts structured resume data from a DOCX or DOC file using the specified AI provider. The file should be sent as a base64-encoded string along with AI provider credentials and the document's media type. Returns a complete ResumeData object. Requires authentication.",
			successDescription: "The DOCX was successfully parsed into structured resume data.",
		})
		.input(
			z.object({
				aiProviderId: z.string().optional(),
				file: fileInputSchema,
				mediaType: z.enum([
					"application/msword",
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				]),
			}),
		)
		.use(aiRequestRateLimit)
		.errors({
			BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
			BAD_REQUEST: { message: "The AI returned an improperly formatted structure.", status: 400 },
			TOO_MANY_REQUESTS: {
				message: "Google AI Studio quota reached. Please wait 1 minute and try again.",
				status: 429,
			},
		})
		.handler(async ({ context, input }) => {
			try {
				const provider = await getRunnableProvider(context.user.id, input.aiProviderId);
				return await withAiFallback(
					() =>
						aiService.parseDocx({
							provider: provider.provider,
							model: provider.model,
							apiKey: provider.apiKey,
							baseURL: provider.baseURL ?? "",
							mediaType: input.mediaType,
							file: input.file,
						}),
					(groq) =>
						aiService.parseDocx({
							provider: groq.provider,
							model: groq.model,
							apiKey: groq.apiKey,
							baseURL: groq.baseURL,
							mediaType: input.mediaType,
							file: input.file,
						}),
				);
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				if (isAiQuotaError(error)) throwAiQuotaError();
				if (isCredentialEncryptionUnavailable(error)) throwCredentialEncryptionUnavailable();
				if (isInvalidAiBaseUrlError(error)) throwAiProviderConfigError();
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError();
				if (error instanceof ZodError) throwResumeStructureError(error);
				const message = error instanceof Error ? error.message : "An unexpected error occurred during DOCX parsing.";
				throw new ORPCError("BAD_GATEWAY", { message: `AI provider error: ${message}` });
			}
		}),

	chat: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/chat",
			tags: ["AI"],
			operationId: "aiChat",
			summary: "Chat with AI to modify resume",
			description:
				"Streams a chat response from the configured AI provider. The LLM can call the propose_resume_patches tool to generate JSON Patch proposals for explicit user approval. Requires authentication and AI provider credentials.",
		})
		.input(
			type<{
				aiProviderId?: string;
				messages: UIMessage[];
				resumeId: string;
			}>(),
		)
		.use(aiRequestRateLimit)
		.handler(async ({ context, input }) => {
			try {
				const [provider, resume] = await Promise.all([
					getRunnableProvider(context.user.id, input.aiProviderId),
					resumeService.getById({ id: input.resumeId, userId: context.user.id }),
				]);

				return await withAiFallback(
					() =>
						aiService.chat({
							provider: provider.provider,
							model: provider.model,
							apiKey: provider.apiKey,
							baseURL: provider.baseURL ?? "",
							messages: input.messages,
							resumeData: resume.data,
							resumeUpdatedAt: resume.updatedAt,
						}),
					(groq) =>
						aiService.chat({
							provider: groq.provider,
							model: groq.model,
							apiKey: groq.apiKey,
							baseURL: groq.baseURL,
							messages: input.messages,
							resumeData: resume.data,
							resumeUpdatedAt: resume.updatedAt,
						}),
				);
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				if (isAiQuotaError(error)) throwAiQuotaError();
				if (isCredentialEncryptionUnavailable(error)) throwCredentialEncryptionUnavailable();
				if (isInvalidAiBaseUrlError(error)) throwAiProviderConfigError();
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError();
				throw error;
			}
		}),

	analyzeResume: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/analyze-resume",
			tags: ["AI"],
			operationId: "analyzeResume",
			summary: "Analyze resume and persist latest analysis",
			description:
				"Uses AI to analyze the current resume and returns a structured analysis with scorecard, strengths, and improvement suggestions. The latest analysis is persisted and can be fetched later. Requires authentication and AI credentials.",
			successDescription: "Structured resume analysis returned and persisted successfully.",
		})
		.input(
			z.object({
				aiProviderId: z.string().optional(),
				resumeId: z.string(),
			}),
		)
		.use(aiRequestRateLimit)
		.output(storedResumeAnalysisSchema)
		.errors({
			BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
			BAD_REQUEST: { message: "The AI returned an improperly formatted structure.", status: 400 },
			TOO_MANY_REQUESTS: {
				message: "Google AI Studio quota reached. Please wait 1 minute and try again.",
				status: 429,
			},
		})
		.handler(async ({ context, input }) => {
			try {
				const [provider, resume] = await Promise.all([
					getRunnableProvider(context.user.id, input.aiProviderId),
					resumeService.getById({ id: input.resumeId, userId: context.user.id }),
				]);
				let usedProvider = provider;
				const analysis = await withAiFallback(
					() =>
						aiService.analyzeResume({
							provider: provider.provider,
							model: provider.model,
							apiKey: provider.apiKey,
							baseURL: provider.baseURL ?? "",
							resumeData: resume.data,
						}),
					(groq) => {
						usedProvider = { ...provider, provider: groq.provider, model: groq.model };
						return aiService.analyzeResume({
							provider: groq.provider,
							model: groq.model,
							apiKey: groq.apiKey,
							baseURL: groq.baseURL,
							resumeData: resume.data,
						});
					},
				);

				return await resumeService.analysis.upsert({
					id: input.resumeId,
					userId: context.user.id,
					analysis: {
						...analysis,
						updatedAt: new Date(),
						modelMeta: { provider: usedProvider.provider, model: usedProvider.model },
					},
				});
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				if (isAiQuotaError(error)) throwAiQuotaError();
				if (isCredentialEncryptionUnavailable(error)) throwCredentialEncryptionUnavailable();
				if (isInvalidAiBaseUrlError(error)) throwAiProviderConfigError();
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError();
				if (error instanceof ZodError) {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid resume analysis structure",
						cause: flattenError(error),
					});
				}
				const message = error instanceof Error ? error.message : "An unexpected error occurred during analysis.";
				throw new ORPCError("BAD_GATEWAY", { message: `AI provider error: ${message}` });
			}
		}),

	atsCheck: protectedProcedure
		.route({
			method: "POST",
			path: "/ai/ats-check",
			tags: ["AI"],
			operationId: "atsCheck",
			summary: "Check resume ATS compatibility against a job description",
			description:
				"Analyzes a resume against a specific job description for ATS compatibility. Returns a structured report with score, keyword analysis, section analysis, suggestions, project ideas, power words, and a recommendation. Requires authentication and AI provider credentials.",
			successDescription: "ATS compatibility analysis returned successfully.",
		})
		.input(
			z.object({
				aiProviderId: z.string().optional(),
				resumeId: z.string(),
				jobDescription: z.string().min(1),
				companyName: z.string().optional(),
			}),
		)
		.use(aiRequestRateLimit)
		.output(atsCheckResultSchema)
		.errors({
			BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
			BAD_REQUEST: { message: "The AI returned an improperly formatted structure.", status: 400 },
			TOO_MANY_REQUESTS: {
				message: "Google AI Studio quota reached. Please wait 1 minute and try again.",
				status: 429,
			},
		})
		.handler(async ({ context, input }) => {
			console.log("[AI] ATS_CHECK_STARTED | user:", context.user.id, "| resumeId:", input.resumeId);
			try {
				const [provider, resume] = await Promise.all([
					getRunnableProvider(context.user.id, input.aiProviderId),
					resumeService.getById({ id: input.resumeId, userId: context.user.id }),
				]);
				console.log("[AI] GEMINI_STARTED | ATS |", provider.provider, "|", provider.model);

				const result = await withAiFallback(
					() =>
						aiService.atsCheck({
							provider: provider.provider,
							model: provider.model,
							apiKey: provider.apiKey,
							baseURL: provider.baseURL ?? "",
							resumeData: resume.data,
							jobDescription: input.jobDescription,
							...(input.companyName != null && { companyName: input.companyName }),
						}),
					(groq) =>
						aiService.atsCheck({
							provider: groq.provider,
							model: groq.model,
							apiKey: groq.apiKey,
							baseURL: groq.baseURL,
							resumeData: resume.data,
							jobDescription: input.jobDescription,
							...(input.companyName != null && { companyName: input.companyName }),
						}),
				);
				console.log("[AI] ATS_CHECK_SUCCESS | score:", result.score);
				return result;
			} catch (error) {
				console.error("[AI] ATS_CHECK_FAILED |", error instanceof Error ? error.message : error);
				if (error instanceof ORPCError) throw error;
				if (isAiQuotaError(error)) throwAiQuotaError();
				if (isCredentialEncryptionUnavailable(error)) throwCredentialEncryptionUnavailable();
				if (isInvalidAiBaseUrlError(error)) throwAiProviderConfigError();
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError();
				if (error instanceof ZodError) {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid ATS analysis structure",
						cause: flattenError(error),
					});
				}
				const message = error instanceof Error ? error.message : "An unexpected error occurred during ATS analysis.";
				throw new ORPCError("BAD_GATEWAY", { message: `AI provider error: ${message}` });
			}
		}),
};
