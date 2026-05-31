import { readFileSync } from "node:fs";
import { env } from "@reactive-resume/env/server";
import { aiService } from "./src/features/ai/service";

async function main() {
	const filePath = "/Users/laxmansirvi/Downloads/sample_resume_ats_90_plus.pdf";
	const fileData = readFileSync(filePath);
	const base64Data = fileData.toString("base64");

	const geminiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
	const groqKey = env.GROQ_API_KEY;

	console.log("Checking API Keys...");
	console.log("Gemini Key:", !!geminiKey);
	console.log("Groq Key:", !!groqKey);

	async function getGroq() {
		return {
			provider: "openai-compatible" as const,
			model: "llama-3.3-70b-versatile",
			apiKey: groqKey ?? "",
			baseURL: "https://api.groq.com/openai/v1",
		};
	}

	// 1. Test parsePdf
	console.log("\n--- TEST PARSE PDF ---");
	let resumeData: Awaited<ReturnType<typeof aiService.parsePdf>> | undefined;
	try {
		console.log("Attempting Gemini Parse...");
		resumeData = await aiService.parsePdf({
			provider: "gemini",
			model: "gemini-2.0-flash",
			apiKey: geminiKey ?? "",
			baseURL: "",
			file: { name: "sample_resume_ats_90_plus.pdf", data: base64Data },
			mediaType: "application/pdf",
		});
		console.log("Gemini Parse Success!");
	} catch (err: unknown) {
		console.log("Gemini Parse Failed:", err instanceof Error ? err.message : String(err));
		console.log("Attempting Groq Fallback...");
		const groq = await getGroq();
		resumeData = await aiService.parsePdf({
			...groq,
			file: { name: "sample_resume_ats_90_plus.pdf", data: base64Data },
			mediaType: "application/pdf",
		});
		console.log("Groq Parse Success!");
	}

	if (!resumeData) {
		throw new Error("Resume parsing failed");
	}

	// 2. Test ATS
	console.log("\n--- TEST ATS ---");
	const jobDescription = "Looking for a frontend developer with React, TypeScript, and TailwindCSS experience.";
	let atsResult: Awaited<ReturnType<typeof aiService.atsCheck>> | undefined;
	try {
		console.log("Attempting Gemini ATS...");
		atsResult = await aiService.atsCheck({
			provider: "gemini",
			model: "gemini-2.0-flash",
			apiKey: geminiKey ?? "",
			baseURL: "",
			resumeData: resumeData,
			jobDescription,
		});
		console.log("Gemini ATS Success!");
	} catch (err: unknown) {
		console.log("Gemini ATS Failed:", err instanceof Error ? err.message : String(err));
		console.log("Attempting Groq Fallback...");
		const groq = await getGroq();
		atsResult = await aiService.atsCheck({
			...groq,
			resumeData: resumeData,
			jobDescription,
		});
		console.log("Groq ATS Success!");
	}

	if (!atsResult) {
		throw new Error("ATS check failed");
	}

	console.log("\nATS Score:", atsResult.score);
	console.log("Matched Keywords:", atsResult.keywordAnalysis.matched);
}

main().catch(console.error);
