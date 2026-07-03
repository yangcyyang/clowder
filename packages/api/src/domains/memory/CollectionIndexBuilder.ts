import { createHash } from 'node:crypto';
import type { CollectionManifest } from './collection-types.js';
import type { EvidenceItem, RepoScanner, ScannedEvidence } from './interfaces.js';
import type { SecretFinding } from './SecretScanner.js';
import { SecretScanner } from './SecretScanner.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

export interface CollectionRebuildResult {
  indexed: number;
  skipped: number;
  blocked: boolean;
  secretFindings: SecretFinding[];
  quarantinedFiles: QuarantinedCollectionFile[];
}

export interface QuarantinedCollectionFile {
  anchor: string;
  path: string;
  findings: SecretFinding[];
}

export class CollectionIndexBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly manifest: CollectionManifest,
    private readonly scanner: RepoScanner,
  ) {}

  async rebuild(options?: { force?: boolean }): Promise<CollectionRebuildResult> {
    const force = options?.force ?? false;
    const results = this.scanner.discover(this.manifest.root);

    const secretReport = this.scanSecrets(results);

    if (secretReport.findings.length > 0 && !isSecretQuarantineEnabled()) {
      await this.purgeCollection();
      return {
        indexed: 0,
        skipped: 0,
        blocked: true,
        secretFindings: secretReport.findings,
        quarantinedFiles: [],
      };
    }

    if (secretReport.quarantinedFiles.length > 0) {
      await this.deleteQuarantinedFiles(secretReport.quarantinedFiles);
    }

    const quarantinedAnchors = new Set(secretReport.quarantinedFiles.map((file) => file.anchor));
    const safeResults = results.filter((result) => !quarantinedAnchors.has(result.item.anchor));
    const { indexed, skipped } = await this.indexResults(safeResults, force);
    return {
      indexed,
      skipped,
      blocked: false,
      secretFindings: secretReport.findings,
      quarantinedFiles: secretReport.quarantinedFiles,
    };
  }

  private scanSecrets(results: ScannedEvidence[]): {
    findings: SecretFinding[];
    quarantinedFiles: QuarantinedCollectionFile[];
  } {
    const findings: SecretFinding[] = [];
    const quarantinedFiles: QuarantinedCollectionFile[] = [];

    for (const result of results) {
      const path = result.item.sourcePath ?? result.item.anchor;
      const fileFindings = SecretScanner.scan(result.rawContent, path);
      if (fileFindings.length === 0) continue;
      findings.push(...fileFindings);
      quarantinedFiles.push({
        anchor: result.item.anchor,
        path,
        findings: fileFindings,
      });
    }

    return { findings, quarantinedFiles };
  }

  private async indexResults(results: ScannedEvidence[], force: boolean) {
    const now = new Date().toISOString();
    let indexed = 0;
    let skipped = 0;
    const currentAnchors = new Set<string>();

    for (const result of results) {
      const hash = createHash('sha256').update(result.rawContent).digest('hex');
      const anchor = result.item.anchor;
      currentAnchors.add(anchor);

      if (!force) {
        const existing = await this.store.getByAnchor(anchor);
        if (existing?.sourceHash === hash && existing.authority === this.manifest.reviewPolicy.authorityCeiling) {
          skipped++;
          continue;
        }
      }

      const item: EvidenceItem = {
        ...result.item,
        sourceHash: hash,
        updatedAt: now,
        authority: this.manifest.reviewPolicy.authorityCeiling,
      };
      await this.store.upsert([item]);
      indexed++;
    }

    await this.cleanStale(currentAnchors);
    return { indexed, skipped };
  }

  private async purgeCollection(): Promise<void> {
    const prefix = `${this.manifest.id}:`;
    const db = this.store.getDb();
    const rows = db.prepare('SELECT anchor FROM evidence_docs WHERE anchor LIKE ?').all(`${prefix}%`) as {
      anchor: string;
    }[];
    for (const row of rows) {
      await this.store.deleteByAnchor(row.anchor);
    }
  }

  private async deleteQuarantinedFiles(files: QuarantinedCollectionFile[]): Promise<void> {
    for (const file of files) {
      await this.store.deleteByAnchor(file.anchor);
    }
  }

  private async cleanStale(currentAnchors: Set<string>): Promise<void> {
    const prefix = `${this.manifest.id}:`;
    const db = this.store.getDb();
    const rows = db.prepare('SELECT anchor FROM evidence_docs WHERE anchor LIKE ?').all(`${prefix}%`) as {
      anchor: string;
    }[];
    for (const row of rows) {
      if (!currentAnchors.has(row.anchor)) {
        await this.store.deleteByAnchor(row.anchor);
      }
    }
  }
}

function isSecretQuarantineEnabled(): boolean {
  return process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE === '1';
}
