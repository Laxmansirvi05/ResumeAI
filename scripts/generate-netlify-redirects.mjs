import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = process.env.NETLIFY_DIST_DIR ?? join(workspaceRoot, "apps/web/dist");
const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, "");

const lines = [];

if (backendUrl) {
	const proxyRoutes = [
		{ from: "/api/*", to: `${backendUrl}/api/:splat` },
		{ from: "/mcp", to: `${backendUrl}/mcp` },
		{ from: "/mcp/*", to: `${backendUrl}/mcp/:splat` },
		{ from: "/uploads/*", to: `${backendUrl}/uploads/:splat` },
		{ from: "/.well-known/*", to: `${backendUrl}/.well-known/:splat` },
		{ from: "/schema.json", to: `${backendUrl}/schema.json` },
	];

	for (const route of proxyRoutes) {
		lines.push(`${route.from}\t${route.to}\t200!`);
	}

	console.info(`[netlify] Proxying backend routes to ${backendUrl}`);
} else {
	console.warn(
		"[netlify] BACKEND_URL is not set — API routes will not be proxied. Set BACKEND_URL in Netlify environment variables.",
	);
}

lines.push("/*\t/index.html\t200");

mkdirSync(dirname(join(distDir, "_redirects")), { recursive: true });
writeFileSync(join(distDir, "_redirects"), `${lines.join("\n")}\n`);

console.info(`[netlify] Wrote ${lines.length} redirect rule(s) to ${join(distDir, "_redirects")}`);
