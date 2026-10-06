import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
console.log(JSON.stringify(tables));
try {
  const result = await prisma.paperAccount.findMany();
  console.log('paperAccountResult', JSON.stringify(result));
} catch (error) {
  console.error('paperAccountError', error instanceof Error ? error.message : String(error));
}
await prisma.$disconnect();
