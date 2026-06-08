import type { PoolConfig } from "pg";

export function createPoolConfig(connectionString: string): PoolConfig {
	const config: PoolConfig = { connectionString };

	const needsSsl =
		process.env.DATABASE_SSL === "true" ||
		/sslmode=require|sslmode=verify|ssl=true/i.test(connectionString) ||
		/\.render\.com|\.supabase\.co|\.neon\.tech/i.test(connectionString);

	if (needsSsl) {
		config.ssl = { rejectUnauthorized: false };
	}

	return config;
}
