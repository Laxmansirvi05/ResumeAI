import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { env } from "@reactive-resume/env/server";
import { createApp } from "./http/app";
import { runStartupChecks } from "./startup/checks";

export { createApp } from "./http/app";

async function main() {
	console.info("Starting ResumeAI server...");
	console.info(`NODE_ENV=${process.env.NODE_ENV ?? "development"} SERVER_MODE=${process.env.SERVER_MODE ?? "monolith"}`);

	await runStartupChecks();

	const port =
		process.env.NODE_ENV === "production" ? Number.parseInt(process.env.PORT ?? "3000", 10) : env.SERVER_PORT;

	const app = createApp();

	serve(
		{
			fetch: app.fetch,
			port,
		},
		(info) => {
			console.info(`🚀 Up and running on http://localhost:${info.port}`);
		},
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
