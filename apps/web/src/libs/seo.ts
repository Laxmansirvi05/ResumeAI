const productionRootUrl = "https://resumeai.app/";
const appName = "ResumeAI";
type JsonLd = Record<string, unknown>;

export const getCanonicalRootUrl = (origin?: string): string => {
	if (!origin) return productionRootUrl;

	const url = new URL(origin);
	url.pathname = "/";
	url.search = "";
	url.hash = "";

	return url.toString();
};

export const createNoindexFollowMeta = () => ({ name: "robots", content: "noindex, follow" });

const serializeJsonLdForScript = (data: JsonLd) =>
	JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (character) => {
		switch (character) {
			case "<":
				return "\\u003C";
			case ">":
				return "\\u003E";
			case "&":
				return "\\u0026";
			case "\u2028":
				return "\\u2028";
			case "\u2029":
				return "\\u2029";
			default:
				return character;
		}
	});

const createStructuredDataScript = (id: string, data: JsonLd) => ({
	id,
	type: "application/ld+json",
	children: serializeJsonLdForScript(data),
});

export const getRootStructuredData = (canonicalUrl: string): JsonLd[] => [
	{
		"@type": "WebSite",
		name: appName,
		url: canonicalUrl,
	},
	{
		"@type": ["SoftwareApplication", "WebApplication"],
		name: appName,
		url: canonicalUrl,
		description:
			"ResumeAI is a premium, AI-powered resume builder that simplifies the process of creating, updating, and sharing your resume.",
		applicationCategory: "BusinessApplication",
		operatingSystem: "Web",
	},
	{
		"@type": "Project",
		name: appName,
		url: canonicalUrl,
	},
	{
		"@type": "FAQPage",
		mainEntity: homeFaqJsonLdItems.map((item) => ({
			"@type": "Question",
			name: item.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: item.answer,
			},
		})),
	},
];

export const createRootStructuredDataScript = (canonicalUrl: string) =>
	createStructuredDataScript("resumeai-structured-data", {
		"@context": "https://schema.org",
		"@graph": getRootStructuredData(canonicalUrl),
	});

const homeFaqJsonLdItems = [
	{
		question: "Is ResumeAI free to use?",
		answer: "Yes! ResumeAI offers a generous free tier to get you started building your perfect resume.",
	},
	{
		question: "How is my data protected?",
		answer: "Your data is stored securely and is never shared with third parties. Privacy is our top priority.",
	},
	{
		question: "Can I export my resume to PDF?",
		answer:
			"Absolutely! You can export your resume to PDF with a single click. The exported PDF maintains all your formatting and styling perfectly.",
	},
	{
		question: "Is ResumeAI available in multiple languages?",
		answer:
			"Yes, ResumeAI is available in multiple languages. You can choose your preferred language in the settings page.",
	},
	{
		question: "What makes ResumeAI different from other resume builders?",
		answer:
			"ResumeAI is a premium, AI-powered platform focusing on modern, cinematic designs and intelligent resume generation.",
	},
	{
		question: "How do I share my resume?",
		answer:
			"You can share your resume via a unique public URL, protect it with a password, or download it as a PDF to share directly. The choice is yours!",
	},
] as const;
