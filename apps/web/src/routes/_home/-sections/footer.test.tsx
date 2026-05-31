// @vitest-environment happy-dom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { Footer } = await import("./footer");

const renderFooter = () => render(<Footer />);

describe("Footer", () => {
	it("renders the footer element", () => {
		const { container } = renderFooter();
		expect(container.querySelector("footer")).toBeInTheDocument();
	});

	it("renders the copyright year", () => {
		const { container } = renderFooter();
		const year = new Date().getFullYear().toString();
		expect(container.textContent).toContain(year);
	});
});
