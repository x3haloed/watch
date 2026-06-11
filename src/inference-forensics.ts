import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelRequestLogDir } from './paths.js';
import type { JsonObject } from './types.js';

export type ModelRequestSnapshot = {
  sequence: number;
  provider: string;
  modelId: string;
  providerModel: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  capturedAt: string;
};

export type ModelRequestRecorder = (body: Record<string, unknown>, metadata: {
  provider: string;
  modelId: string;
  providerModel: string;
}) => void;

export class InferenceForensics {
  private sequence = 0;
  private snapshots: ModelRequestSnapshot[] = [];

  constructor(
    private readonly instanceRoot: string,
    private readonly soundingId: string,
  ) {}

  recorder(): ModelRequestRecorder {
    return (body, metadata) => {
      const capturedAt = new Date().toISOString();
      const sequence = ++this.sequence;
      const dir = modelRequestLogDir(this.instanceRoot);
      mkdirSync(dir, { recursive: true });
      const filename = `${this.safeFilePart(this.soundingId)}-${String(sequence).padStart(3, '0')}.json`;
      const path = join(dir, filename);
      const content = `${JSON.stringify({
        capturedAt,
        soundingId: this.soundingId,
        sequence,
        ...metadata,
        body,
      }, null, 2)}\n`;
      const sha256 = createHash('sha256').update(content).digest('hex');
      writeFileSync(path, content, 'utf8');
      this.snapshots.push({
        sequence,
        provider: metadata.provider,
        modelId: metadata.modelId,
        providerModel: metadata.providerModel,
        path,
        sha256,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        capturedAt,
      });
    };
  }

  latest(): ModelRequestSnapshot | undefined {
    return this.snapshots.at(-1);
  }

  all(): ModelRequestSnapshot[] {
    return [...this.snapshots];
  }

  latestJson(): JsonObject | undefined {
    const latest = this.latest();
    return latest ? snapshotToJson(latest) : undefined;
  }

  allJson(): JsonObject[] {
    return this.snapshots.map(snapshotToJson);
  }

  private safeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'sounding';
  }
}

function snapshotToJson(snapshot: ModelRequestSnapshot): JsonObject {
  return {
    sequence: snapshot.sequence,
    provider: snapshot.provider,
    modelId: snapshot.modelId,
    providerModel: snapshot.providerModel,
    path: snapshot.path,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.sizeBytes,
    capturedAt: snapshot.capturedAt,
  };
}
