import { PrismaClient } from '@prisma/client';

const databaseUrl = (() => {
	const baseUrl = process.env.DATABASE_URL;
	if (!baseUrl) {
		throw new Error('DATABASE_URL must be configured');
	}
	return baseUrl.includes('?') ? `${baseUrl}&connect_timeout=1` : `${baseUrl}?connect_timeout=1`;
})();

export const prisma = new PrismaClient({
	datasources: {
		db: {
			url: databaseUrl,
		},
	},
});
