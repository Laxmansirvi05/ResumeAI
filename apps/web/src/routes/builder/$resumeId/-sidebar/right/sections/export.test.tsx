// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const downloadWithAnchor = vi.hoisted(() => vi.fn());
const createResumePdfBlob = vi.hoisted(() => vi.fn().mockResolvedValue(new Blob(["x"], { type: "application/pdf" })));

vi.mock("../shared/section-base", () => ({
	SectionBase: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@reactive-resume/utils/file", () => ({
	downloadWithAnchor,
	generateFilename: (name: string, ext: string) => `${name}.${ext}`,
}));
vi.mock("@/features/resume/export/pdf-document", () => ({ createResumePdfBlob }));
vi.mock("@/features/resume/builder/draft", () => ({
	useResume: () => ({ id: "r1", name: "My Resume", data: defaultResumeData }),
}));

const { ExportSectionBuilder } = await import("./export");

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

afterEach(() => {
	downloadWithAnchor.mockReset();
	createResumePdfBlob.mockClear();
});

const renderExport = () =>
	render(
		<I18nProvider i18n={i18n}>
			<ExportSectionBuilder />
		</I18nProvider>,
	);

describe("ExportSectionBuilder", () => {
	it("renders the PDF action button", () => {
		renderExport();
		expect(screen.getByText("PDF")).toBeInTheDocument();
	});

	it("calls createResumePdfBlob and downloads when PDF is clicked", async () => {
		renderExport();
		const button = screen.getByText("PDF").closest("button") as HTMLButtonElement;

		fireEvent.click(button);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(createResumePdfBlob).toHaveBeenCalledTimes(1);
		expect(downloadWithAnchor).toHaveBeenCalledTimes(1);
		expect(downloadWithAnchor.mock.calls[0]?.[1]).toBe("My Resume.pdf");
	});
});
