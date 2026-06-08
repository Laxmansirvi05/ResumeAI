import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPoolConfig } from "@reactive-resume/db/pool-config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { env } from "@reactive-resume/env/server";
import { findWorkspaceRoot, getLocalDataDirectory } from "@reactive-resume/utils/monorepo.node";

function resolveFromCurrentModule(relativePath: string) {
	return fileURLToPath(new URL(relativePath, import.meta.url));
}

function resolveMigrationsFolder(): string {
	const candidates = [
		process.env.MIGRATIONS_FOLDER,
		findWorkspaceRoot() ? path.join(findWorkspaceRoot() as string, "migrations") : null,
		path.join(process.cwd(), "migrations"),
	];

	let dir = resolveFromCurrentModule(".");
	while (dir !== path.dirname(dir)) {
		candidates.push(path.join(dir, "migrations"));
		dir = path.dirname(dir);
	}

	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}

	throw new Error(
		`Could not locate migrations folder. Checked cwd=${process.cwd()} and parents of ${resolveFromCurrentModule(".")}`,
	);
}

async function runDatabaseMigrations() {
	console.info("Running database migrations...");

	const pool = new Pool(createPoolConfig(env.DATABASE_URL));
	const db = drizzle({ client: pool });

	try {
		const migrationsFolder = resolveMigrationsFolder();
		console.info(`Using migrations folder: ${migrationsFolder}`);
		await migrate(db, { migrationsFolder });
		console.info("Database migrations completed");
	} catch (error) {
		console.error("Database migrations failed", { error });
		throw error;
	} finally {
		await pool.end();
	}
}

async function validateLocalStoragePath() {
	if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET) {
		console.info("S3 storage configured — skipping local storage validation");
		return;
	}

	const dataDirectory = getLocalDataDirectory(env.LOCAL_STORAGE_PATH);
	console.info(`Validating local storage path: ${dataDirectory}`);

	try {
		await fs.mkdir(dataDirectory, { recursive: true });
		await fs.access(dataDirectory, constants.R_OK | constants.W_OK);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error(
			`Local storage path is not writable: ${dataDirectory}\n` +
				`  ${message}\n` +
				"Set LOCAL_STORAGE_PATH to a writable directory or fix permissions on the existing path.",
		);
		throw error;
	}
}

export async function runStartupChecks() {
	await runDatabaseMigrations();
	await validateLocalStoragePath();
}
