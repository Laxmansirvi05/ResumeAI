import { readFileSync } from "node:fs";
import { env } from "@reactive-resume/env/server";
import { aiService } from "./service";

async function main() {
	const filePath = "apps/web/dist/templates/pdf/gengar.pdf";
	const fileData = readFileSync(filePath);
	const base64Data = fileData.toString("base64");

	const geminiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!geminiKey) {
		console.error("No Gemini Key in env");
		return;
	}

	try {
		const result = await aiService.parsePdf({
			provider: "gemini",
			model: "gemini-2.0-flash",
			apiKey: geminiKey,
			baseURL: "",
			file: {
				name: "gengar.pdf",
				data: base64Data,
			},
			mediaType: "application/pdf",
		});
		console.log("Success! Extracted basic info:", result.basics);
	} catch (err: unknown) {
		console.error("Test failed:");
		console.error(err);
		if (err instanceof Error && "cause" in err) {
			console.error("Cause:", (err as { cause?: unknown }).cause);
		}
	}
}

main();
