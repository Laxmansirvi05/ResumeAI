import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { deepmergeCustom } from "deepmerge-ts";
import { jsonrepair } from "jsonrepair";
import { flattenError, ZodError } from "zod";
import { resumeDataSchema } from "@reactive-resume/schema/resume/data";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { isObject } from "@reactive-resume/utils/sanitize";
import { generateId } from "@reactive-resume/utils/string";
import { buildAiExtractionTemplate } from "./extraction-template";

const aiExtractionTemplate = buildAiExtractionTemplate();

type SectionKey = keyof typeof sectionRequiredFieldMap;

type CoercionEntry = {
	path: string;
	fromType: string;
	toType: string;
};

type DroppedSectionItemEntry = {
	section: SectionKey;
	index: number;
	reason: string;
};

export type ResumeSanitizationDiagnostics = {
	coercions: CoercionEntry[];
	droppedSectionItems: DroppedSectionItemEntry[];
	salvageApplied: boolean;
};

export type ResumeSanitizationResult = {
	data: ResumeData;
	diagnostics: ResumeSanitizationDiagnostics;
};

const mergeDefaultsDeep = deepmergeCustom({
	filterValues: (values) => values.filter((value) => value !== undefined && value !== null),
	mergeArrays: false,
});

const sectionRequiredFieldMap = {
	profiles: "network",
	experience: "company",
	education: "school",
	projects: "name",
	skills: "name",
	languages: "language",
	interests: "name",
	awards: "title",
	certifications: "title",
	publications: "title",
	volunteer: "organization",
	references: "name",
} as const;

function getValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function mergeDefaults<T extends Record<string, unknown>, S extends Record<string, unknown>>(
	target: T,
	source: S,
): T & S {
	if (!isObject(target) || !isObject(source)) {
		return (source !== undefined && source !== null ? source : target) as T & S;
	}

	return mergeDefaultsDeep(target, source) as T & S;
}

function coerceBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return;
	}
	if (typeof value !== "string") return;

	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	return;
}

function coerceNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return;

	const normalized = value.trim();
	if (normalized.length === 0) return;

	const coerced = Number(normalized);
	return Number.isFinite(coerced) ? coerced : undefined;
}

function coerceValueAgainstTemplate(
	value: unknown,
	template: unknown,
	path: string,
	diagnostics: ResumeSanitizationDiagnostics,
): unknown {
	if (value === undefined || value === null) return value;
	if (template === undefined || template === null) return value;

	if (typeof template === "boolean") {
		const coerced = coerceBoolean(value);
		if (coerced === undefined) return value;
		if (coerced === value) return value;

		diagnostics.coercions.push({ path, fromType: getValueType(value), toType: "boolean" });
		return coerced;
	}

	if (typeof template === "number") {
		const coerced = coerceNumber(value);
		if (coerced === undefined) return value;
		if (coerced === value) return value;

		diagnostics.coercions.push({ path, fromType: getValueType(value), toType: "number" });
		return coerced;
	}

	if (Array.isArray(template) && Array.isArray(value)) {
		const itemTemplate = template[0];
		if (itemTemplate === undefined) return value;

		return value.map((entry, index) =>
			coerceValueAgainstTemplate(entry, itemTemplate, `${path}[${index}]`, diagnostics),
		);
	}

	if (!isObject(template) || !isObject(value)) return value;

	const output: Record<string, unknown> = { ...value };

	for (const key of Object.keys(template)) {
		if (!(key in output)) continue;

		const nextPath = path.length > 0 ? `${path}.${key}` : key;
		output[key] = coerceValueAgainstTemplate(output[key], template[key], nextPath, diagnostics);
	}

	return output;
}

function getJsonBoundaryIndices(value: string): { first: number; last: number } {
	const firstCurly = value.indexOf("{");
	const firstSquare = value.indexOf("[");
	const lastCurly = value.lastIndexOf("}");
	const lastSquare = value.lastIndexOf("]");

	let first = -1;
	if (firstCurly !== -1 && firstSquare !== -1) {
		first = Math.min(firstCurly, firstSquare);
	} else {
		first = Math.max(firstCurly, firstSquare);
	}

	return { first, last: Math.max(lastCurly, lastSquare) };
}

function mapAiParserVariations(data: Record<string, unknown>): Record<string, unknown> {
	if (!isObject(data)) return data;

	const output = { ...data };
	if (!isObject(output.sections)) {
		output.sections = {};
	}
	const sections = { ...(output.sections as Record<string, unknown>) };

	const mapping: Record<string, SectionKey | "summary"> = {
		skill: "skills",
		skills: "skills",
		workExperience: "experience",
		experience: "experience",
		projectList: "projects",
		projects: "projects",
		education: "education",
		certifications: "certifications",
		summary: "summary",
	};

	const normalizeItemsArray = (items: unknown[], mappedKey: string) => {
		return items.map((item) => {
			if (typeof item === "string") {
				if (mappedKey === "skills") return { name: item };
				if (mappedKey === "experience") return { company: item, position: "Role", date: "" };
				if (mappedKey === "education") return { institution: item, area: "", date: "" };
				if (mappedKey === "projects") return { name: item, description: "" };
				if (mappedKey === "certifications") return { name: item, issuer: "" };
				return { name: item };
			}
			if (isObject(item)) {
				// Map common wrong keys in items
				if (mappedKey === "experience") {
					if (item.companyName && !item.company) item.company = item.companyName;
					if (item.title && !item.position) item.position = item.title;
					if (item.role && !item.position) item.position = item.role;
					if (item.dates && !item.date) item.date = item.dates;
				}
				if (mappedKey === "education") {
					if (item.school && !item.institution) item.institution = item.school;
					if (item.university && !item.institution) item.institution = item.university;
					if (item.degree && !item.area) item.area = item.degree;
				}
				if (mappedKey === "projects") {
					if (item.title && !item.name) item.name = item.title;
				}
			}
			return item;
		});
	};

	// 1. Map top-level variations
	for (const key of Object.keys(output)) {
		const mappedKey = mapping[key];
		if (mappedKey) {
			if (mappedKey === "summary") {
				if (typeof output[key] === "string") {
					output.summary = { content: output[key] };
				} else if (isObject(output[key]) && typeof (output[key] as Record<string, unknown>).content === "string") {
					output.summary = output[key];
				}
			} else {
				// Must go to sections[mappedKey]
				const itemsArray = Array.isArray(output[key])
					? output[key]
					: isObject(output[key]) && Array.isArray((output[key] as Record<string, unknown>).items)
						? (output[key] as Record<string, unknown>).items
						: [];

				if (Array.isArray(itemsArray) && itemsArray.length > 0) {
					sections[mappedKey] = {
						items: normalizeItemsArray(itemsArray, mappedKey),
					};
				} else if (isObject(output[key])) {
					// LLM sometimes just returns the section directly
					sections[mappedKey] = output[key];
				}
			}
		}
	}

	// 2. Map sections variations and normalize their items too
	for (const key of Object.keys(sections)) {
		const mappedKey = mapping[key] || key; // If no mapping, assume the key is correct

		if (mappedKey && mappedKey !== key) {
			sections[mappedKey] = sections[key];
			// We can delete sections[key] here if we want to clean up, but keeping it is fine as schema validation strips unknowns
		}

		// Ensure items array exists and is normalized
		const sectionObj = sections[mappedKey];
		if (isObject(sectionObj)) {
			if (Array.isArray(sectionObj.items)) {
				sectionObj.items = normalizeItemsArray(sectionObj.items, mappedKey);
			} else if (Array.isArray(sections[key])) {
				// Sometimes sections[key] is just the array directly instead of { items: [...] }
				sections[mappedKey] = { items: normalizeItemsArray(sections[key] as unknown[], mappedKey) };
			}
		} else if (Array.isArray(sections[key])) {
			sections[mappedKey] = { items: normalizeItemsArray(sections[key] as unknown[], mappedKey) };
		}
	}

	// 3. Fix name mapping if in root
	if (typeof output.name === "string" || typeof output.fullName === "string") {
		const name = output.name || output.fullName;
		if (!isObject(output.basics)) {
			output.basics = {};
		}
		if (!(output.basics as Record<string, unknown>).name) {
			(output.basics as Record<string, unknown>).name = name;
		}
	}

	output.sections = sections;
	return output;
}

function normalizeResumeDataForSchema(data: Record<string, unknown>, diagnostics: ResumeSanitizationDiagnostics) {
	if (!isObject(data)) return data;
	if (!isObject(data.sections)) return data;

	const normalizedSections: Record<string, unknown> = { ...data.sections };

	for (const sectionKey of Object.keys(sectionRequiredFieldMap) as SectionKey[]) {
		const section = normalizedSections[sectionKey];
		if (!isObject(section)) continue;
		if (!Array.isArray(section.items)) continue;

		const itemTemplate = aiExtractionTemplate.sections[sectionKey].items[0] as Record<string, unknown>;
		const requiredField = sectionRequiredFieldMap[sectionKey];

		const normalizedItems = section.items
			.filter((item): item is Record<string, unknown> => isObject(item))
			.map((item) => {
				const mergedItem = mergeDefaults(itemTemplate, item);
				return coerceValueAgainstTemplate(
					mergedItem,
					itemTemplate,
					`sections.${sectionKey}.items`,
					diagnostics,
				) as Record<string, unknown>;
			})
			.filter((item, index) => {
				const requiredValue = item[requiredField];
				if (typeof requiredValue !== "string" || requiredValue.trim().length === 0) {
					diagnostics.salvageApplied = true;
					diagnostics.droppedSectionItems.push({
						section: sectionKey,
						index,
						reason: `missing required "${requiredField}"`,
					});
					return false;
				}

				return true;
			})
			.map((item) => {
				const normalizedItem = { ...item };
				if (typeof normalizedItem.id !== "string" || normalizedItem.id.trim().length === 0) {
					diagnostics.salvageApplied = true;
					normalizedItem.id = generateId();
				}
				if (typeof normalizedItem.hidden !== "boolean") {
					diagnostics.salvageApplied = true;
					normalizedItem.hidden = false;
				}

				return normalizedItem;
			});

		normalizedSections[sectionKey] = { ...section, items: normalizedItems };
	}

	return { ...data, sections: normalizedSections };
}

export function sanitizeAndParseResumeJson(resultText: string): ResumeSanitizationResult {
	let jsonString = resultText;
	const { first, last } = getJsonBoundaryIndices(jsonString);
	if (first !== -1 && last !== -1 && last >= first) {
		jsonString = jsonString.substring(first, last + 1);
	}

	try {
		const diagnostics: ResumeSanitizationDiagnostics = {
			coercions: [],
			droppedSectionItems: [],
			salvageApplied: false,
		};

		const repairedJson = jsonrepair(jsonString);
		console.log("[AI_DEBUG] RAW_JSON_STRING: ", jsonString.slice(0, 500));

		const parsedJson = JSON.parse(repairedJson);
		console.log("[AI_DEBUG] PARSED_JSON_ROOT_KEYS: ", Object.keys(parsedJson));

		const mappedJson = mapAiParserVariations(parsedJson as Record<string, unknown>);
		console.log(
			"[AI_DEBUG] MAPPED_JSON_SECTIONS: ",
			Object.keys((mappedJson.sections as Record<string, unknown>) || {}),
		);

		const mergedData = mergeDefaults(defaultResumeData, mappedJson);
		const coercedData = coerceValueAgainstTemplate(mergedData, defaultResumeData, "", diagnostics);
		const normalizedData = normalizeResumeDataForSchema(coercedData as Record<string, unknown>, diagnostics);
		console.log(
			"[AI_DEBUG] NORMALIZED_DATA_SECTIONS: ",
			Object.keys((normalizedData.sections as Record<string, unknown>) || {}),
		);

		const data = resumeDataSchema.parse({
			...normalizedData,
			customSections: [],
			picture: defaultResumeData.picture,
			metadata: defaultResumeData.metadata,
		});

		return { data, diagnostics };
	} catch (error: unknown) {
		if (error instanceof ZodError) {
			console.error("Zod validation failed during resume parsing:", flattenError(error));
			throw error;
		}

		console.error("Unknown error during resume data validation:", error);
		throw new Error("An unknown error occurred while validating the merged resume data.");
	}
}
