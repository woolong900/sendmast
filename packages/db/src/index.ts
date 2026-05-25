export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';

import { PrismaClient } from '@prisma/client';

let prismaSingleton: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return prismaSingleton;
}
