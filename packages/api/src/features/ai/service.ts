import type { AIProvider } from "@reactive-resume/ai/types";
import type { ResumeAnalysis } from "@reactive-resume/schema/resume/analysis";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { ModelMessage, UIMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamToEventIterator } from "@orpc/server";
import { createId } from "@paralleldrive/cuid2";
import { convertToModelMessages, createGateway, generateText, Output, stepCountIs, streamText, tool } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { PDFParse } from "pdf-parse";
import { match } from "ts-pattern";
import { z } from "zod";
import {
	analyzeResumeSystemPrompt as analyzeResumeSystemPromptTemplate,
	atsCheckSystemPrompt as atsCheckSystemPromptTemplate,
	chatSystemPromptTemplate,
	docxParserSystemPrompt,
	docxParserUserPrompt,
	pdfParserSystemPrompt,
	pdfParserUserPrompt,
} from "@reactive-resume/ai/prompts";
import { buildAiExtractionTemplate } from "@reactive-resume/ai/resume/extraction-template";
import { sanitizeAndParseResumeJson } from "@reactive-resume/ai/resume/sanitize";
import {
	normalizeResumePatchProposals,
	resumePatchProposalToolInputSchema,
	resumePatchProposalToolOutputSchema,
} from "@reactive-resume/ai/tools/patch-proposal";
import { aiProviderSchema } from "@reactive-resume/ai/types";
import { applyResumePatches } from "@reactive-resume/resume/patch";
import { resumeAnalysisOutputSchema, resumeAnalysisSchema } from "@reactive-resume/schema/resume/analysis";
import { atsCheckOutputSchema, atsCheckResultSchema } from "@reactive-resume/schema/resume/ats-check";
import { supportsProviderNativeWebSearch } from "./capabilities";
import { resolveAiBaseUrl } from "./url-policy";

const aiExtractionTemplate = buildAiExtractionTemplate();

function logAndRethrow(context: string, error: unknown): never {
	if (error instanceof Error) {
		console.error(`${context}:`, error);
		throw error;
	}

	console.error(`${context}:`, error);
	throw new Error(`An unknown error occurred during ${context}.`);
}

/**
 * Strips markdown code fences (```json ... ```) if present, then JSON.parses.
 * Used for Groq fallback paths where Output.object() is not supported and the
 * model returns raw JSON text (sometimes wrapped in a markdown block).
 */
function sanitizeAndParseJson(text: string): unknown {
	// Remove leading/trailing whitespace
	let clean = text.trim();
	// Strip ```json ... ``` or ``` ... ``` fences
	clean = clean
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();
	try {
		return JSON.parse(clean);
	} catch {
		// Try to find the first { ... } or [ ... ] block in case there's surrounding text
		const match = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by match
		if (match) return JSON.parse(match[1]!);
		throw new Error(`[AI] Could not parse JSON from response. First 200 chars: ${clean.slice(0, 200)}`);
	}
}

function parseAndValidateResumeJson(resultText: string): ResumeData {
	const { data, diagnostics } = sanitizeAndParseResumeJson(resultText);

	if (diagnostics.coercions.length === 0 && diagnostics.droppedSectionItems.length === 0) return data;

	const droppedBySection = diagnostics.droppedSectionItems.reduce<Record<string, number>>((acc, item) => {
		acc[item.section] = (acc[item.section] ?? 0) + 1;
		return acc;
	}, {});

	console.info("AI resume sanitization diagnostics", {
		coercions: diagnostics.coercions.length,
		droppedBySection,
		salvageApplied: diagnostics.salvageApplied,
	});

	return data;
}

type GetModelInput = {
	provider: AIProvider;
	model: string;
	apiKey: string;
	baseURL?: string;
};

const MAX_AI_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_AI_FILE_BASE64_CHARS = Math.ceil((MAX_AI_FILE_BYTES * 4) / 3) + 4;

export function getModel(input: GetModelInput) {
	const { provider, model, apiKey } = input;
	const baseURL = provider === "gemini" ? "" : resolveAiBaseUrl(input);

	// [DEBUG] Temporary logging — remove after confirming Gemini works
	console.log("[AI Debug] Provider:", provider, "| Model:", model, "| BaseURL:", baseURL, "| Key present:", !!apiKey);

	return match(provider)
		.with("openai", () => createOpenAI({ apiKey, baseURL }).chat(model))
		.with("anthropic", () => createAnthropic({ apiKey, baseURL }).languageModel(model))
		.with("gemini", () => {
			console.log("[AI] Creating Gemini provider with explicit API key");
			return createGoogleGenerativeAI({ apiKey })(model);
		})
		.with("vercel-ai-gateway", () => createGateway({ apiKey, baseURL }).languageModel(model))
		.with("openrouter", () => createOpenAICompatible({ name: "openrouter", apiKey, baseURL }).languageModel(model))
		.with("openai-compatible", () =>
			createOpenAICompatible({ name: "openai-compatible", apiKey, baseURL }).languageModel(model),
		)
		.with("ollama", () => {
			const ollama = createOllama({
				name: "ollama",
				baseURL,
				...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
			});

			return ollama.languageModel(model);
		})
		.exhaustive();
}

export function getAgentModel(input: GetModelInput) {
	if (!supportsProviderNativeWebSearch(input)) return getModel(input);

	return createOpenAI({ apiKey: input.apiKey, baseURL: resolveAiBaseUrl(input) }).responses(input.model);
}

const aiCredentialsSchema = z.object({
	provider: aiProviderSchema,
	model: z.string().trim().min(1),
	apiKey: z.string().trim().min(1),
	baseURL: z.string().optional().default(""),
});

export const fileInputSchema = z.object({
	name: z.string(),
	data: z.string().max(MAX_AI_FILE_BASE64_CHARS, "File is too large. Maximum size is 2MB."),
});

type TestConnectionInput = z.infer<typeof aiCredentialsSchema>;

export async function testConnection(input: TestConnectionInput): Promise<boolean> {
	const RESPONSE_OK = "1";

	const result = await generateText({
		model: getModel(input),
		output: Output.choice({ options: [RESPONSE_OK] }),
		messages: [{ role: "user", content: `Respond only with JSON Object: { "result": "${RESPONSE_OK}" }` }],
	});

	return result.output === RESPONSE_OK;
}

type ParsePdfInput = z.infer<typeof aiCredentialsSchema> & {
	file: z.infer<typeof fileInputSchema>;
	mediaType?: string;
};

type BuildResumeParsingMessagesInput = {
	systemPrompt: string;
	userPrompt: string;
	file: z.infer<typeof fileInputSchema>;
	mediaType: string;
	provider?: string;
	extractedText: string;
};

/** Maximum characters of extracted file text sent to any AI provider. */
const MAX_EXTRACTED_TEXT_CHARS = 10_000;

/**
 * Cleans raw text extracted from a binary file (PDF/DOCX base64 decode).
 * Removes binary noise, collapses whitespace, deduplicates repeated lines.
 */
function cleanExtractedText(raw: string): string {
	// 1. Strip non-printable / control characters (keep tab \t and newline \n)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Required to sanitize raw PDF output
	let text = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]+/g, " ");
	// 2. Collapse runs of whitespace within a line to a single space
	text = text.replace(/[ \t]+/g, " ");
	// 3. Split into lines and deduplicate consecutive identical lines
	const lines = text.split(/\r?\n/);
	const dedupedLines: string[] = [];
	let prevLine = "";
	for (const line of lines) {
		const trimmed = line.trim();
		// Skip empty lines that follow another empty line
		if (trimmed === "" && prevLine === "") continue;
		// Skip lines that are exact duplicates of the previous non-empty line
		if (trimmed !== "" && trimmed === prevLine) continue;
		dedupedLines.push(trimmed);
		prevLine = trimmed;
	}
	return dedupedLines.join("\n").trim();
}

/**
 * Truncates text to MAX_EXTRACTED_TEXT_CHARS characters, appending a notice
 * so the AI knows the content was cut.
 */
function truncateToMaxChars(text: string, label = "resume"): string {
	if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return text;
	const truncated = text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
	console.log(
		"[AI] TEXT_TRUNCATED | label:",
		label,
		"| original:",
		text.length,
		"| truncated to:",
		MAX_EXTRACTED_TEXT_CHARS,
	);
	return `${truncated}\n\n[... ${label} text truncated to ${MAX_EXTRACTED_TEXT_CHARS} characters ...]`;
}

/**
 * Decodes a base64-encoded file, extracts printable text, cleans it,
 * and truncates to the safe context limit.
 * Used as a text-only fallback for providers that do not support multimodal file attachments.
 */
async function extractTextFromBase64File(base64Data: string, filename: string): Promise<string> {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		let raw = "";
		if (filename.toLowerCase().endsWith(".pdf") || base64Data.startsWith("JVBERi0")) {
			const parser = new PDFParse({ data: buffer });
			const data = await parser.getText();
			raw = data.text;
			await parser.destroy();
		} else {
			raw = buffer.toString("latin1");
		}

		const cleaned = cleanExtractedText(raw);
		const truncated = truncateToMaxChars(cleaned, filename);
		console.log("[AI] TEXT_EXTRACTED | file:", filename, "| cleaned:", cleaned.length, "| sent:", truncated.length);
		return truncated;
	} catch (err) {
		console.warn("[AI] TEXT_EXTRACT_FAILED | file:", filename, err instanceof Error ? err.message : err);
		return "[Could not extract text from file]";
	}
}

function buildResumeParsingMessages({
	systemPrompt,
	userPrompt,
	file,
	mediaType,
	provider,
	extractedText,
}: BuildResumeParsingMessagesInput): ModelMessage[] {
	const systemContent = `${systemPrompt}\n\nIMPORTANT: You must return ONLY raw valid JSON. Do not return markdown, do not return explanations. Just the JSON object. Use the following JSON as a template and fill in the extracted values. For arrays, you MUST use the exact key names shown in the template (e.g. use 'description' instead of 'summary', 'website' instead of 'url'):\n\n${JSON.stringify(aiExtractionTemplate, null, 2)}`;

	const textContent = `${userPrompt}\n\nHere is the raw text extracted from the document to help with accurate parsing:\n\n<document_text>\n${extractedText}\n</document_text>`;

	if (provider === "openai-compatible" || provider === "ollama") {
		return [
			{ role: "system", content: systemContent },
			{ role: "user", content: textContent },
		];
	}

	// Default: multimodal content + text fallback
	return [
		{ role: "system", content: systemContent },
		{
			role: "user",
			content: [
				{ type: "text", text: textContent },
				{ type: "file", data: file.data, mediaType, filename: file.name },
			],
		},
	];
}

async function parsePdf(input: ParsePdfInput): Promise<ResumeData> {
	console.log(
		"[AI] PARSE_PDF_STARTED | provider:",
		input.provider,
		"| model:",
		input.model,
		"| file:",
		input.file.name,
	);
	const model = getModel(input);

	const rawText = await extractTextFromBase64File(input.file.data, input.file.name);

	const messages = buildResumeParsingMessages({
		systemPrompt: pdfParserSystemPrompt,
		userPrompt: pdfParserUserPrompt,
		file: input.file,
		mediaType: input.mediaType ?? "application/pdf",
		provider: input.provider,
		extractedText: rawText,
	});

	if (input.provider === "openai-compatible") {
		console.log("[AI] GROQ_REQUEST_STARTED | parsePdf | model:", input.model);
		console.log("[AI] GROQ_REQUEST_BODY_VALID | plain-text messages:", messages.length);
	}

	const result = await generateText({
		model,
		messages,
	}).catch((error: unknown) => logAndRethrow("Failed to generate the text with the model", error));

	console.log("[AI] PARSE_PDF_SUCCESS | text length:", result.text.length);
	if (input.provider === "openai-compatible") console.log("[AI] GROQ_SUCCESS | parsePdf");
	const data = parseAndValidateResumeJson(result.text);

	applyRawTextFallback(data, rawText);
	return data;
}

type ParseDocxInput = z.infer<typeof aiCredentialsSchema> & {
	file: z.infer<typeof fileInputSchema>;
	mediaType: "application/msword" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
};

async function parseDocx(input: ParseDocxInput): Promise<ResumeData> {
	const model = getModel(input);

	const rawText = await extractTextFromBase64File(input.file.data, input.file.name);

	const messages = buildResumeParsingMessages({
		systemPrompt: docxParserSystemPrompt,
		userPrompt: docxParserUserPrompt,
		file: input.file,
		mediaType: input.mediaType,
		provider: input.provider,
		extractedText: rawText,
	});

	if (input.provider === "openai-compatible") {
		console.log("[AI] GROQ_REQUEST_STARTED | parseDocx | model:", input.model);
		console.log("[AI] GROQ_REQUEST_BODY_VALID | plain-text messages:", messages.length);
	}

	const result = await generateText({
		model,
		messages,
	}).catch((error: unknown) => logAndRethrow("Failed to generate the text with the model", error));

	if (input.provider === "openai-compatible") console.log("[AI] GROQ_SUCCESS | parseDocx");
	const data = parseAndValidateResumeJson(result.text);

	applyRawTextFallback(data, rawText);
	return data;
}

function applyRawTextFallback(data: ResumeData, rawText: string) {
	if (!rawText || rawText.length < 50) return;

	const s = data.sections;
	const hasSkills = s.skills?.items?.length > 0;
	const hasExp = s.experience?.items?.length > 0;
	const hasEdu = s.education?.items?.length > 0;
	const hasProj = s.projects?.items?.length > 0;
	const hasCert = s.certifications?.items?.length > 0;

	// If it already found data, don't overwrite
	if (hasSkills && hasExp && hasEdu && hasProj) return;

	console.log("[AI] APPLYING_RAW_TEXT_FALLBACK | Analyzing text for missing sections...");

	const _textLower = rawText.toLowerCase();

	// Crude chunking by newlines or common headers
	const lines = rawText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l);

	let currentSection = "summary";
	let currentBuffer: string[] = [];

	const pushBuffer = () => {
		if (currentBuffer.length === 0) return;
		const content = currentBuffer.join(" ").trim();
		if (!content) return;

		// Map to appropriate section
		if (currentSection === "summary" && (!data.summary?.content || data.summary.content.length < 10)) {
			if (!data.summary) data.summary = { content: "", visible: true };
			data.summary.content = content.slice(0, 1000);
		} else if (currentSection === "skills" && !hasSkills) {
			s.skills.items = content
				.split(/[,\n]/)
				.filter((s) => s.trim().length > 1)
				.map((skill) => ({
					id: createId(),
					name: skill.trim(),
					description: "",
					level: 0,
					keywords: [],
					hidden: false,
				}));
		} else if (currentSection === "experience" && !hasExp) {
			s.experience.items.push({
				id: createId(),
				company: "Experience entry",
				position: "Role",
				date: "",
				location: "",
				url: { href: "", label: "" },
				summary: content.slice(0, 500),
				hidden: false,
			});
		} else if (currentSection === "education" && !hasEdu) {
			s.education.items.push({
				id: createId(),
				institution: "Education entry",
				area: content.slice(0, 100),
				studyType: "",
				date: "",
				score: "",
				url: { href: "", label: "" },
				summary: "",
				hidden: false,
			});
		} else if (currentSection === "projects" && !hasProj) {
			s.projects.items.push({
				id: createId(),
				name: "Project entry",
				description: content.slice(0, 200),
				date: "",
				url: { href: "", label: "" },
				summary: "",
				hidden: false,
				keywords: [],
			});
		} else if (currentSection === "certifications" && !hasCert) {
			s.certifications.items.push({
				id: createId(),
				name: content.slice(0, 100),
				issuer: "",
				date: "",
				url: { href: "", label: "" },
				summary: "",
				hidden: false,
			});
		}
		currentBuffer = [];
	};

	for (const line of lines) {
		const lower = line.toLowerCase();
		if (lower === "skills" || lower === "technical skills") {
			pushBuffer();
			currentSection = "skills";
		} else if (lower === "experience" || lower === "work experience" || lower === "employment") {
			pushBuffer();
			currentSection = "experience";
		} else if (lower === "education" || lower === "academics") {
			pushBuffer();
			currentSection = "education";
		} else if (lower === "projects") {
			pushBuffer();
			currentSection = "projects";
		} else if (lower === "certifications" || lower === "licenses") {
			pushBuffer();
			currentSection = "certifications";
		} else {
			currentBuffer.push(line);
		}
	}
	pushBuffer();
}

function buildChatSystemPrompt(resumeData: ResumeData): string {
	return chatSystemPromptTemplate.replace("{{RESUME_DATA}}", JSON.stringify(resumeData, null, 2));
}

type ChatInput = z.infer<typeof aiCredentialsSchema> & {
	messages: UIMessage[];
	resumeData: ResumeData;
	resumeUpdatedAt: Date;
};

async function chat(input: ChatInput) {
	const model = getModel(input);
	const systemPrompt = buildChatSystemPrompt(input.resumeData);

	const result = streamText({
		model,
		system: systemPrompt,
		messages: await convertToModelMessages(input.messages),
		tools: {
			propose_resume_patches: tool({
				description:
					"Return one or more cohesive resume change proposals. Each proposal must include a title, optional summary, and valid JSON Patch operations against the current resume data. The tool validates but does not apply changes.",
				inputSchema: resumePatchProposalToolInputSchema,
				outputSchema: resumePatchProposalToolOutputSchema,
				execute: async (toolInput) => {
					const proposals = normalizeResumePatchProposals(toolInput, input.resumeUpdatedAt);

					for (const proposal of proposals) {
						applyResumePatches(input.resumeData, proposal.operations);
					}

					return { proposals };
				},
			}),
		},
		stopWhen: stepCountIs(3),
	});

	return streamToEventIterator(result.toUIMessageStream());
}

type AnalyzeResumeInput = z.infer<typeof aiCredentialsSchema> & {
	resumeData: ResumeData;
};

function buildAnalyzeResumeSystemPrompt(resumeData: ResumeData, provider?: string): string {
	// Groq: tighter truncation to stay inside context limits
	const resumeLimit = provider === "openai-compatible" ? 6_000 : undefined;
	const resumeStr = JSON.stringify(resumeData, null, 2);
	const safeResumeStr = resumeLimit ? resumeStr.slice(0, resumeLimit) : resumeStr;
	return `${analyzeResumeSystemPromptTemplate}\n\n## Resume Data\n\n${safeResumeStr}`;
}

async function analyzeResume(input: AnalyzeResumeInput): Promise<ResumeAnalysis> {
	const model = getModel(input);
	const systemPrompt = buildAnalyzeResumeSystemPrompt(input.resumeData, input.provider);
	const userMsg =
		"Analyze this resume and return a structured report with scorecard, overall score, strengths, and actionable suggestions.";

	// Groq (openai-compatible) does not support Output.object — parse JSON from raw text
	if (input.provider === "openai-compatible") {
		const groqResult = await generateText({
			model,
			messages: [
				{
					role: "system",
					content: `${systemPrompt}\n\nIMPORTANT: Respond ONLY with a raw JSON object. No markdown, no explanation, just the JSON.`,
				},
				{ role: "user", content: userMsg },
			],
		}).catch((error: unknown) => logAndRethrow("analyzeResume (Groq) failed", error));
		const parsed = sanitizeAndParseJson(groqResult.text);
		return resumeAnalysisSchema.parse(parsed);
	}

	// Default path: structured output via AI SDK
	const result = await generateText({
		model,
		output: Output.object({ schema: resumeAnalysisOutputSchema }),
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userMsg },
		],
	});

	if (result.output == null) {
		throw new Error("AI returned no structured analysis output.");
	}

	return resumeAnalysisSchema.parse(result.output);
}

/**
 * Strips HTML tags and decodes common HTML entities to plain text.
 * Used when extracting text from `summary` fields stored as HTML strings.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Converts structured ResumeData into a human-readable plain-text string.
 * Uses the EXACT field names from packages/schema/src/resume/data.ts.
 *
 * Key schema facts:
 *  - resume.summary.content  → top-level summary (NOT in sections)
 *  - resume.sections.experience.items[].{company, position, period, description}
 *  - resume.sections.education.items[].{school, degree, area, period, description}
 *  - resume.sections.skills.items[].{name, keywords[]}
 *  - resume.sections.projects.items[].{name, description}
 *  - resume.sections.certifications.items[].{title, issuer, date}
 *  - resume.sections.languages.items[].{language, fluency}
 */
function flattenResumeToText(resume: ResumeData): string {
	// Debug: dump raw resume structure to verify field names
	console.log("[AI] RAW_RESUME_JSON", JSON.stringify(resume, null, 2).slice(0, 3000));

	const lines: string[] = [];

	// ── Basics ────────────────────────────────────────────────────────────────
	const b = resume.basics;
	if (b) {
		if (b.name) lines.push(`Name: ${b.name}`);
		if (b.headline) lines.push(`Headline: ${b.headline}`);
		if (b.email) lines.push(`Email: ${b.email}`);
		if (b.phone) lines.push(`Phone: ${b.phone}`);
		if (b.location) lines.push(`Location: ${b.location}`);
		// Custom fields (e.g. LinkedIn, GitHub)
		if (b.customFields && Array.isArray(b.customFields)) {
			for (const cf of b.customFields) {
				if (cf.text) lines.push(cf.text);
			}
		}
	}

	// ── Summary (TOP-LEVEL field, not inside sections) ────────────────────────
	if (resume.summary?.content) {
		const summaryText = stripHtml(resume.summary.content);
		if (summaryText) {
			lines.push("\nSUMMARY:");
			lines.push(summaryText);
		}
	}

	const sec = resume.sections;
	if (!sec) {
		console.log("[AI] FLATTEN_WARN | resume.sections is", typeof sec);
		const result = lines.join("\n").trim();
		console.log("[AI] FLATTEN_RESULT | lines:", lines.length, "| chars:", result.length);
		return result;
	}

	// ── Skills ─────────────────────────────────────────────────────────────────
	if (sec.skills?.items && sec.skills.items.length > 0) {
		lines.push("\nSKILLS:");
		for (const skill of sec.skills.items) {
			if (skill.hidden) continue;
			const parts: string[] = [];
			if (skill.name) parts.push(skill.name);
			if (skill.proficiency) parts.push(`(${skill.proficiency})`);
			const kws = (skill.keywords ?? []).filter(Boolean).join(", ");
			if (kws) parts.push(`— ${kws}`);
			if (parts.length > 0) lines.push(parts.join(" "));
		}
	}

	// ── Experience ─────────────────────────────────────────────────────────────
	if (sec.experience?.items && sec.experience.items.length > 0) {
		lines.push("\nEXPERIENCE:");
		for (const exp of sec.experience.items) {
			if (exp.hidden) continue;
			const header: string[] = [];
			if (exp.position) header.push(exp.position);
			if (exp.company) header.push(`at ${exp.company}`);
			if (exp.location) header.push(`(${exp.location})`);
			if (exp.period) header.push(`[${exp.period}]`);
			if (header.length > 0) lines.push(header.join(" "));
			if (exp.description) {
				const desc = stripHtml(exp.description);
				if (desc) lines.push(desc);
			}
			// Sub-roles for career progression
			for (const role of exp.roles ?? []) {
				if (role.position) lines.push(`  Role: ${role.position} (${role.period ?? ""})`);
				if (role.description) {
					const rd = stripHtml(role.description);
					if (rd) lines.push(`  ${rd}`);
				}
			}
		}
	}

	// ── Education ──────────────────────────────────────────────────────────────
	if (sec.education?.items && sec.education.items.length > 0) {
		lines.push("\nEDUCATION:");
		for (const edu of sec.education.items) {
			if (edu.hidden) continue;
			const header: string[] = [];
			if (edu.degree) header.push(edu.degree);
			if (edu.area) header.push(`in ${edu.area}`);
			if (edu.school) header.push(`at ${edu.school}`);
			if (edu.period) header.push(`[${edu.period}]`);
			if (edu.grade) header.push(`Grade: ${edu.grade}`);
			if (header.length > 0) lines.push(header.join(" "));
			if (edu.description) {
				const desc = stripHtml(edu.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Projects ───────────────────────────────────────────────────────────────
	if (sec.projects?.items && sec.projects.items.length > 0) {
		lines.push("\nPROJECTS:");
		for (const proj of sec.projects.items) {
			if (proj.hidden) continue;
			const header: string[] = [];
			if (proj.name) header.push(proj.name);
			if (proj.period) header.push(`[${proj.period}]`);
			if (header.length > 0) lines.push(header.join(" "));
			if (proj.description) {
				const desc = stripHtml(proj.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Certifications ─────────────────────────────────────────────────────────
	if (sec.certifications?.items && sec.certifications.items.length > 0) {
		lines.push("\nCERTIFICATIONS:");
		for (const cert of sec.certifications.items) {
			if (cert.hidden) continue;
			const header: string[] = [];
			if (cert.title) header.push(cert.title);
			if (cert.issuer) header.push(`— ${cert.issuer}`);
			if (cert.date) header.push(`(${cert.date})`);
			if (header.length > 0) lines.push(header.join(" "));
			if (cert.description) {
				const desc = stripHtml(cert.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Languages ──────────────────────────────────────────────────────────────
	if (sec.languages?.items && sec.languages.items.length > 0) {
		lines.push("\nLANGUAGES:");
		for (const lang of sec.languages.items) {
			if (lang.hidden) continue;
			const parts: string[] = [];
			if (lang.language) parts.push(lang.language);
			if (lang.fluency) parts.push(`(${lang.fluency})`);
			if (parts.length > 0) lines.push(parts.join(" "));
		}
	}

	// ── Awards ─────────────────────────────────────────────────────────────────
	if (sec.awards?.items && sec.awards.items.length > 0) {
		lines.push("\nAWARDS:");
		for (const award of sec.awards.items) {
			if (award.hidden) continue;
			const header: string[] = [];
			if (award.title) header.push(award.title);
			if (award.awarder) header.push(`— ${award.awarder}`);
			if (award.date) header.push(`(${award.date})`);
			if (header.length > 0) lines.push(header.join(" "));
			if (award.description) {
				const desc = stripHtml(award.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Volunteer ──────────────────────────────────────────────────────────────
	if (sec.volunteer?.items && sec.volunteer.items.length > 0) {
		lines.push("\nVOLUNTEER:");
		for (const vol of sec.volunteer.items) {
			if (vol.hidden) continue;
			const header: string[] = [];
			if (vol.organization) header.push(vol.organization);
			if (vol.location) header.push(`(${vol.location})`);
			if (vol.period) header.push(`[${vol.period}]`);
			if (header.length > 0) lines.push(header.join(" "));
			if (vol.description) {
				const desc = stripHtml(vol.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Publications ───────────────────────────────────────────────────────────
	if (sec.publications?.items && sec.publications.items.length > 0) {
		lines.push("\nPUBLICATIONS:");
		for (const pub of sec.publications.items) {
			if (pub.hidden) continue;
			const header: string[] = [];
			if (pub.title) header.push(pub.title);
			if (pub.publisher) header.push(`— ${pub.publisher}`);
			if (pub.date) header.push(`(${pub.date})`);
			if (header.length > 0) lines.push(header.join(" "));
			if (pub.description) {
				const desc = stripHtml(pub.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── References ─────────────────────────────────────────────────────────────
	if (sec.references?.items && sec.references.items.length > 0) {
		lines.push("\nREFERENCES:");
		for (const ref of sec.references.items) {
			if (ref.hidden) continue;
			const header: string[] = [];
			if (ref.name) header.push(ref.name);
			if (ref.position) header.push(`— ${ref.position}`);
			if (header.length > 0) lines.push(header.join(" "));
			if (ref.description) {
				const desc = stripHtml(ref.description);
				if (desc) lines.push(desc);
			}
		}
	}

	// ── Profiles ───────────────────────────────────────────────────────────────
	if (sec.profiles?.items && sec.profiles.items.length > 0) {
		lines.push("\nPROFILES:");
		for (const profile of sec.profiles.items) {
			if (profile.hidden) continue;
			const parts: string[] = [];
			if (profile.network) parts.push(profile.network);
			if (profile.username) parts.push(profile.username);
			if (parts.length > 0) lines.push(parts.join(": "));
		}
	}

	// ── Interests ──────────────────────────────────────────────────────────────
	if (sec.interests?.items && sec.interests.items.length > 0) {
		lines.push("\nINTERESTS:");
		for (const interest of sec.interests.items) {
			if (interest.hidden) continue;
			const kws = (interest.keywords ?? []).filter(Boolean).join(", ");
			lines.push(interest.name ? `${interest.name}: ${kws}` : kws);
		}
	}

	// ── Custom Sections ───────────────────────────────────────────────────────
	if (resume.customSections && Array.isArray(resume.customSections)) {
		for (const cs of resume.customSections) {
			if (cs.hidden) continue;
			const sectionTitle = cs.title || "CUSTOM SECTION";
			lines.push(`\n${sectionTitle.toUpperCase()}:`);
			if (cs.items && Array.isArray(cs.items)) {
				for (const item of cs.items) {
					if (item.hidden) continue;
					// Custom section items can be any type — extract common text fields
					const textParts: string[] = [];
					if ("name" in item && typeof item.name === "string" && item.name) textParts.push(item.name);
					if ("title" in item && typeof item.title === "string" && item.title) textParts.push(item.title);
					if ("company" in item && typeof item.company === "string" && item.company) textParts.push(item.company);
					if ("organization" in item && typeof item.organization === "string" && item.organization)
						textParts.push(item.organization);
					if ("school" in item && typeof item.school === "string" && item.school) textParts.push(item.school);
					if ("position" in item && typeof item.position === "string" && item.position) textParts.push(item.position);
					if ("period" in item && typeof item.period === "string" && item.period) textParts.push(`[${item.period}]`);
					if ("date" in item && typeof item.date === "string" && item.date) textParts.push(`(${item.date})`);
					if (textParts.length > 0) lines.push(textParts.join(" "));
					if ("content" in item && typeof item.content === "string" && item.content) {
						const ct = stripHtml(item.content);
						if (ct) lines.push(ct);
					}
					if ("description" in item && typeof item.description === "string" && item.description) {
						const desc = stripHtml(item.description);
						if (desc) lines.push(desc);
					}
					if ("keywords" in item && Array.isArray(item.keywords)) {
						const kws = item.keywords.filter((k): k is string => typeof k === "string" && k.length > 0).join(", ");
						if (kws) lines.push(kws);
					}
				}
			}
		}
	}

	const result = lines.join("\n").trim();
	console.log("[AI] FLATTEN_RESULT | lines:", lines.length, "| chars:", result.length);
	return result;
}

/**
 * Recursively walks any JSON value and collects all non-empty string leaves.
 * This is a field-name-agnostic fallback: it extracts every piece of text
 * stored in the JSON regardless of schema shape or dropped items.
 * Keys that are UUIDs, color values (rgba), URLs, or purely numeric are skipped.
 *
 * IMPORTANT: Only skip keys that are purely structural/visual. Content-bearing
 * keys like "name", "title", "description", "content", "text" must NOT be skipped.
 */
function scrapeTextFromJson(value: unknown, depth = 0): string[] {
	if (depth > 12) return [];
	if (typeof value === "string") {
		const stripped = stripHtml(value).trim();
		// Skip UUIDs, color values, URLs, empty strings, single chars, and pure numbers
		if (!stripped) return [];
		if (stripped.length < 2) return [];
		if (/^[0-9a-f-]{36}$/i.test(stripped)) return []; // UUID
		if (/^rgba?\(/.test(stripped)) return []; // color
		if (/^https?:\/\//.test(stripped)) return []; // URL
		if (/^\d+(\.\d+)?$/.test(stripped)) return []; // pure number
		// Skip single-word font families and common design tokens
		if (/^(serif|sans-serif|monospace|inherit|initial|revert)$/i.test(stripped)) return [];
		return [stripped];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => scrapeTextFromJson(item, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		// ONLY skip keys that are purely structural/visual — NOT content fields
		const SKIP_KEYS = new Set([
			// Design / layout / metadata — never contain ATS-relevant text
			"metadata",
			"layout",
			"design",
			"typography",
			"page",
			"colors",
			"level",
			"picture",
			"website",
			"icon",
			"iconColor",
			"borderColor",
			"borderRadius",
			"borderWidth",
			"shadowColor",
			"shadowWidth",
			"fontFamily",
			"fontWeights",
			"fontSize",
			"lineHeight",
			"pages",
			"sidebarWidth",
			"main",
			"sidebar",
			"fullWidth",
			"template",
			"primary",
			"background",
			"body",
			"heading",
			"hidden",
			"columns",
			"id",
			"inlineLink",
			"url",
			// keep: "title", "text", "name", "label", "notes",
			// "description", "content", "customFields" — all contain text
		]);
		return Object.entries(value as Record<string, unknown>).flatMap(([key, val]) => {
			if (SKIP_KEYS.has(key)) return [];
			return scrapeTextFromJson(val, depth + 1);
		});
	}
	return [];
}

/**
 * Builds a plain-text resume representation for ATS keyword matching.
 *
 * Strategy:
 *  1. Try schema-aware flattenResumeToText() — uses exact typed field names.
 *  2. If result is too short (< 100 chars), fall back to scrapeTextFromJson()
 *     which extracts every non-empty string from the JSON regardless of field names.
 *  3. If both fail, fall back to JSON.stringify of the resume data sections
 *     so the AI at least sees something.
 *
 * GUARANTEE: never returns an empty string.
 */
function buildResumeTextForAts(resumeData: ResumeData, limit: number): string {
	// First attempt: schema-aware flatten
	const structured = flattenResumeToText(resumeData);
	if (structured.length >= 100) {
		console.log("[AI] ATS_TEXT | using schema-aware text | chars:", structured.length);
		console.log("[AI] ATS_TEXT\n", structured.slice(0, 500));
		console.log("[AI] TEXT_LENGTH", structured.length);
		return structured.slice(0, limit);
	}

	// Fallback: scrape all string values from the JSON tree
	console.log(
		"[AI] ATS_TEXT | schema-aware text too short (",
		structured.length,
		"chars) — falling back to JSON scraper",
	);
	console.log("[AI] ATS_RESUME_DUMP", JSON.stringify(resumeData, null, 2).slice(0, 3000));

	const scraped = scrapeTextFromJson(resumeData);
	// Deduplicate and join
	const deduped = [...new Set(scraped)];
	const fallbackText = deduped.join("\n");
	console.log("[AI] ATS_TEXT | scraped", deduped.length, "text fragments | total chars:", fallbackText.length);

	if (fallbackText.length >= 50) {
		console.log("[AI] ATS_TEXT\n", fallbackText.slice(0, 500));
		console.log("[AI] TEXT_LENGTH", fallbackText.length);
		return fallbackText.slice(0, limit);
	}

	// Last resort: dump raw JSON of basics + sections + summary so the AI has something
	console.log("[AI] ATS_TEXT | scraper also too short — using raw JSON dump as last resort");
	const rawParts: string[] = [];
	if (resumeData.basics) rawParts.push(JSON.stringify(resumeData.basics));
	if (resumeData.summary) rawParts.push(JSON.stringify(resumeData.summary));
	if (resumeData.sections) rawParts.push(JSON.stringify(resumeData.sections));
	if (resumeData.customSections) rawParts.push(JSON.stringify(resumeData.customSections));
	const rawText = rawParts.join("\n").slice(0, limit);
	console.log("[AI] ATS_TEXT | raw JSON fallback chars:", rawText.length);
	console.log("[AI] TEXT_LENGTH", rawText.length);

	// Absolute guarantee: never return empty
	return rawText || "[No resume text could be extracted]";
}

type AtsCheckInput = z.infer<typeof aiCredentialsSchema> & {
	resumeData: ResumeData;
	jobDescription: string;
	companyName?: string;
};

/**
 * Builds the ATS check system prompt.
 * Sends BOTH structured JSON and a plain-text rendering of the resume.
 * Guarantees resumeText is non-empty even when all section items were dropped
 * during PDF parsing, by falling back to a raw JSON string scraper.
 */
function buildAtsCheckSystemPrompt(
	resumeData: ResumeData,
	jobDescription: string,
	companyName: string | undefined,
	provider?: string,
): string {
	const isGroq = provider === "openai-compatible";
	const resumeJsonLimit = isGroq ? 5_000 : 12_000;
	const resumeTextLimit = isGroq ? 3_000 : 6_000;
	const jobDescLimit = isGroq ? 3_500 : 8_000;

	const resumeJson = JSON.stringify(resumeData, null, 2).slice(0, resumeJsonLimit);
	const resumeText = buildResumeTextForAts(resumeData, resumeTextLimit);
	const safeJobDescStr = jobDescription.slice(0, jobDescLimit);

	console.log(
		"[AI] ATS_TEXT_EXTRACTED | provider:",
		provider ?? "default",
		"| resumeJson chars:",
		resumeJson.length,
		"| resumeText chars:",
		resumeText.length,
		"| jd chars:",
		safeJobDescStr.length,
	);
	console.log("[AI] ATS_TEXT\n", resumeText.slice(0, 500));

	// Section detection for debug logging
	const sectionsFound: string[] = [];
	if (resumeData.summary?.content) sectionsFound.push("summary");
	const sec = resumeData.sections;
	if (sec?.experience?.items?.length) sectionsFound.push(`experience(${sec.experience.items.length})`);
	if (sec?.education?.items?.length) sectionsFound.push(`education(${sec.education.items.length})`);
	if (sec?.skills?.items?.length) sectionsFound.push(`skills(${sec.skills.items.length})`);
	if (sec?.projects?.items?.length) sectionsFound.push(`projects(${sec.projects.items.length})`);
	if (sec?.certifications?.items?.length) sectionsFound.push(`certifications(${sec.certifications.items.length})`);
	if (sec?.languages?.items?.length) sectionsFound.push(`languages(${sec.languages.items.length})`);
	if (sec?.awards?.items?.length) sectionsFound.push(`awards(${sec.awards.items.length})`);
	if (sec?.volunteer?.items?.length) sectionsFound.push(`volunteer(${sec.volunteer.items.length})`);
	if (sec?.publications?.items?.length) sectionsFound.push(`publications(${sec.publications.items.length})`);
	if (sec?.references?.items?.length) sectionsFound.push(`references(${sec.references.items.length})`);
	if (sec?.profiles?.items?.length) sectionsFound.push(`profiles(${sec.profiles.items.length})`);
	if (resumeData.customSections?.length) sectionsFound.push(`customSections(${resumeData.customSections.length})`);
	// Also count scraped text as a signal for section detection fallback
	const hasScrapedContent = resumeText.length > 0 && sectionsFound.length === 0;
	if (hasScrapedContent) sectionsFound.push("(scraped-from-json)");
	console.log("[AI] ATS_SECTIONS_FOUND |", sectionsFound.join(", ") || "none");

	const parts = [
		atsCheckSystemPromptTemplate,
		"\n\n## Resume JSON (structured)\n\n",
		resumeJson,
		"\n\n## Resume Plain Text (use for keyword matching)\n\n",
		resumeText,
		"\n\n## Job Description\n\n",
		safeJobDescStr,
	];

	if (companyName) {
		parts.push("\n\n## Company Name\n\n", companyName.slice(0, 200));
	}

	return parts.join("");
}

async function atsCheck(input: AtsCheckInput) {
	const model = getModel(input);
	const systemPrompt = buildAtsCheckSystemPrompt(
		input.resumeData,
		input.jobDescription,
		input.companyName,
		input.provider,
	);

	const userMsg =
		"Analyze this resume against the job description and return a structured ATS compatibility report with score, keyword analysis, section analysis, suggestions, suggested projects, power words, and recommendation.";

	// Groq (openai-compatible) does not support Output.object — generate plain text and parse JSON
	if (input.provider === "openai-compatible") {
		console.log("[AI] ATS_GROQ_REQUEST_STARTED | model:", input.model);
		const groqResult = await generateText({
			model,
			messages: [
				{
					role: "system",
					content: `${systemPrompt}\n\nIMPORTANT: Respond ONLY with a raw JSON object. No markdown, no explanation, just the JSON.`,
				},
				{ role: "user", content: userMsg },
			],
		}).catch((error: unknown) => logAndRethrow("ATS check (Groq) failed", error));
		console.log("[AI] ATS_GROQ_SUCCESS | response length:", groqResult.text.length);
		const parsed = sanitizeAndParseJson(groqResult.text);
		const validated = atsCheckResultSchema.parse(parsed);
		console.log(
			"[AI] ATS_KEYWORDS_MATCHED |",
			validated.keywordAnalysis.matched.length,
			"matched |",
			validated.keywordAnalysis.missing.length,
			"missing",
		);
		console.log("[AI] ATS_SCORE_CALCULATED | score:", validated.score, "| recommendation:", validated.recommendation);
		return validated;
	}

	// Default path: structured output via AI SDK
	const result = await generateText({
		model,
		output: Output.object({ schema: atsCheckOutputSchema }),
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userMsg },
		],
	});

	if (result.output == null) {
		throw new Error("AI returned no structured ATS analysis output.");
	}

	const validated = atsCheckResultSchema.parse(result.output);
	console.log(
		"[AI] ATS_KEYWORDS_MATCHED |",
		validated.keywordAnalysis.matched.length,
		"matched |",
		validated.keywordAnalysis.missing.length,
		"missing",
	);
	console.log("[AI] ATS_SCORE_CALCULATED | score:", validated.score, "| recommendation:", validated.recommendation);
	return validated;
}

export const aiService = {
	analyzeResume,
	atsCheck,
	chat,
	parseDocx,
	parsePdf,
	testConnection,
};
