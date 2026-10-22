/**
 * Registration of freshly trained models (pnpm ml:train). A new model is always a NEW, immutable registry row with
 * status TRAINED and no PAPER approval: training never selects, approves, activates or replaces a model, and never
 * touches any user's strategy selection (MlPaperSettings). An existing version is refused, never overwritten.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
export { ML_TRAINING_KEY } from '@soltrader/strategy-engine';

export interface TrainedModelMetadata {
  modelVersion: string;
  algorithm: string;
  readiness: string;
  featureVersion: string;
  labelVersion: string;
  target: string;
  config: unknown;
  trainedAt: string;
  metrics: Record<string, unknown>;
}

export async function registerTrainedModel(
  prisma: Pick<PrismaClient, 'mlModelVersion'>,
  input: { metadata: TrainedModelMetadata; datasetVersion: string; artifactPath: string; artifactHash: string; actor: string; extraMetrics: Record<string, unknown> },
) {
  const { metadata } = input;
  const existing = await prisma.mlModelVersion.findUnique({ where: { version: metadata.modelVersion }, select: { version: true } });
  if (existing) throw new Error(`Model ${metadata.modelVersion} already registered (immutable): train with a new dataset version or seed`);
  return prisma.mlModelVersion.create({
    data: {
      version: metadata.modelVersion, algorithm: metadata.algorithm, status: 'TRAINED', readiness: metadata.readiness, featureVersion: metadata.featureVersion,
      labelVersion: metadata.labelVersion, target: metadata.target, datasetVersion: input.datasetVersion, config: metadata.config as Prisma.InputJsonValue,
      artifactPath: input.artifactPath, artifactHash: input.artifactHash, metrics: input.extraMetrics as Prisma.InputJsonValue,
      statusHistory: [{ status: 'TRAINED', at: new Date().toISOString(), by: input.actor }] as Prisma.InputJsonValue, createdBy: input.actor, trainedAt: new Date(metadata.trainedAt),
      // Explicit: a trained model has no PAPER approval and is selected by nobody.
      paperApproved: false,
    },
  });
}

/** Autonomous ML bundle registration: a new immutable TRAINED row, never approved, selected or activated. */
export async function registerAutonomousBundle(
  prisma: Pick<PrismaClient, 'mlAutonomousModelBundle'>,
  input: { version: string; readiness: string; featureVersion: string; labelVersion: string; datasetVersion: string; artifactPath: string; artifactHash: string; policy: unknown; metrics: unknown; trainedAt: string; actor: string },
) {
  const existing = await prisma.mlAutonomousModelBundle.findUnique({ where: { version: input.version }, select: { version: true } });
  if (existing) throw new Error(`Bundle ${input.version} already registered (immutable): train with a new dataset version or seed`);
  return prisma.mlAutonomousModelBundle.create({
    data: {
      version: input.version, status: 'TRAINED', readiness: input.readiness, featureVersion: input.featureVersion, labelVersion: input.labelVersion, datasetVersion: input.datasetVersion,
      artifactPath: input.artifactPath, artifactHash: input.artifactHash, policy: input.policy as Prisma.InputJsonValue, metrics: input.metrics as Prisma.InputJsonValue,
      statusHistory: [{ status: 'TRAINED', at: new Date().toISOString(), by: input.actor }] as Prisma.InputJsonValue, createdBy: input.actor, trainedAt: new Date(input.trainedAt), paperApproved: false,
    },
  });
}

