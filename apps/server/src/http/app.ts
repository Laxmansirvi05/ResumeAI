import { Hono } from "hono";
import { handleWebApp, handleWebAppHead, serveWebDistStatic } from "../static/web";
import { registerBackendRoutes } from "./backend";

export function createBackendApp() {
	const app = new Hono();

	registerBackendRoutes(app);

	app.all("/*", (c) => c.text("Not Found", 404));

	return app;
}

export function createMonolithApp() {
	const app = new Hono();

	registerBackendRoutes(app);

	app.use("/*", serveWebDistStatic);
	app.on(["GET"], "/*", (c) => handleWebApp(c.req.raw));
	app.on(["HEAD"], "/*", (c) => handleWebAppHead(c.req.raw));

	return app;
}

export function createApp() {
	return process.env.SERVER_MODE === "backend-only" ? createBackendApp() : createMonolithApp();
}
