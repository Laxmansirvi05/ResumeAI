import { readFileSync } from "node:fs";

const readPrompt = (filename: string) => {
	return readFileSync(new URL(`./prompts/${filename}`, import.meta.url), "utf-8");
};

const analyzeResumeSystemPrompt = readPrompt("analyze-resume-system.md");
const atsCheckSystemPrompt = readPrompt("ats-check-system.md");
const chatSystemPromptTemplate = readPrompt("chat-system.md");
const docxParserSystemPrompt = readPrompt("docx-parser-system.md");
const docxParserUserPrompt = readPrompt("docx-parser-user.md");
const pdfParserSystemPrompt = readPrompt("pdf-parser-system.md");
const pdfParserUserPrompt = readPrompt("pdf-parser-user.md");

export {
	analyzeResumeSystemPrompt,
	atsCheckSystemPrompt,
	chatSystemPromptTemplate,
	docxParserSystemPrompt,
	docxParserUserPrompt,
	pdfParserSystemPrompt,
	pdfParserUserPrompt,
};
