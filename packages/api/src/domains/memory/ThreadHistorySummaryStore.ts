import type Database from 'better-sqlite3';

export interface ThreadHistorySummarySegment {
  id: string;
  threadId: string;
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  summary: string;
  generatedAt: string;
  modelId: string;
  promptVersion: string;
}

interface SummarySegmentRow {
  id: string;
  thread_id: string;
  from_message_id: string;
  to_message_id: string;
  message_count: number;
  summary: string;
  generated_at: string;
  model_id: string;
  prompt_version: string;
}

export interface IThreadHistorySummaryStore {
  listLatestByThread(threadId: string, limit?: number): Promise<ThreadHistorySummarySegment[]>;
}

function mapRow(row: SummarySegmentRow): ThreadHistorySummarySegment {
  return {
    id: row.id,
    threadId: row.thread_id,
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    messageCount: row.message_count,
    summary: row.summary,
    generatedAt: row.generated_at,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
  };
}

export class SqliteThreadHistorySummaryStore implements IThreadHistorySummaryStore {
  constructor(private readonly db: Database.Database) {}

  async listLatestByThread(threadId: string, limit = 4): Promise<ThreadHistorySummarySegment[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 12);
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, from_message_id, to_message_id, message_count,
                summary, generated_at, model_id, prompt_version
           FROM summary_segments
          WHERE thread_id = ?
          ORDER BY generated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(threadId, safeLimit) as SummarySegmentRow[];

    return rows.reverse().map(mapRow);
  }
}
