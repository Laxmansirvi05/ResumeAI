import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandIcon } from "./brand-icon";

describe("BrandIcon", () => {
	it("renders a text span", () => {
		const { container } = render(<BrandIcon />);
		const span = container.querySelector("span");
		expect(span).toBeDefined();
		expect(span?.textContent).toBe("ResumeAI");
	});

	it("uses 'logo' as default variant", () => {
		const { container } = render(<BrandIcon />);
		const span = container.querySelector("span");
		expect(span?.textContent).toBe("ResumeAI");
	});

	it("uses 'icon' variant when specified", () => {
		const { container } = render(<BrandIcon variant="icon" />);
		const span = container.querySelector("span");
		expect(span?.textContent).toBe("R-AI");
	});

	it("merges custom className", () => {
		const { container } = render(<BrandIcon className="my-custom" />);
		const span = container.querySelector("span");
		expect(span).toHaveClass("my-custom");
	});
});
