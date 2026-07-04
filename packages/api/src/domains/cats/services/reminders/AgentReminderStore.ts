import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

export type AgentReminderStatus = 'scheduled' | 'fired' | 'canceled';

export interface AgentReminder {
  id: string;
  catId: string;
  threadId: string;
  sourceMessageId?: string;
  message: string;
  fireAt: number;
  status: AgentReminderStatus;
  createdAt: number;
  updatedAt: number;
  firedAt?: number;
  canceledAt?: number;
}

interface ReminderFile {
  reminders: AgentReminder[];
}

function defaultReminderPath(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'reminders.json');
}

function parseReminderFile(raw: string): ReminderFile {
  const parsed = JSON.parse(raw) as Partial<ReminderFile>;
  return { reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [] };
}

export class AgentReminderStore {
  constructor(private readonly filePath = defaultReminderPath()) {}

  async list(
    filter: { catId?: string; threadId?: string; status?: AgentReminderStatus; sourceMessageId?: string } = {},
  ): Promise<AgentReminder[]> {
    const data = await this.read();
    return data.reminders
      .filter((item) => (filter.catId ? item.catId === filter.catId : true))
      .filter((item) => (filter.threadId ? item.threadId === filter.threadId : true))
      .filter((item) => (filter.status ? item.status === filter.status : true))
      .filter((item) => (filter.sourceMessageId ? item.sourceMessageId === filter.sourceMessageId : true))
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  async schedule(input: {
    catId: string;
    threadId: string;
    sourceMessageId?: string;
    message: string;
    fireAt: number;
  }): Promise<AgentReminder> {
    const data = await this.read();
    if (input.sourceMessageId) {
      const existing = data.reminders.find(
        (item) =>
          item.status === 'scheduled' &&
          item.threadId === input.threadId &&
          item.sourceMessageId === input.sourceMessageId,
      );
      if (existing) return existing;
    }

    const now = Date.now();
    const reminder: AgentReminder = {
      id: randomUUID(),
      catId: input.catId,
      threadId: input.threadId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      message: input.message,
      fireAt: input.fireAt,
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    };
    data.reminders.push(reminder);
    await this.write(data);
    return reminder;
  }

  async cancel(id: string): Promise<AgentReminder | null> {
    const data = await this.read();
    const idx = data.reminders.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const now = Date.now();
    const current = data.reminders[idx]!;
    const updated: AgentReminder = { ...current, status: 'canceled', canceledAt: now, updatedAt: now };
    data.reminders[idx] = updated;
    await this.write(data);
    return updated;
  }

  async due(now = Date.now()): Promise<AgentReminder[]> {
    const data = await this.read();
    return data.reminders.filter((item) => item.status === 'scheduled' && item.fireAt <= now);
  }

  async markFired(id: string): Promise<AgentReminder | null> {
    const data = await this.read();
    const idx = data.reminders.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const now = Date.now();
    const current = data.reminders[idx]!;
    const updated: AgentReminder = { ...current, status: 'fired', firedAt: now, updatedAt: now };
    data.reminders[idx] = updated;
    await this.write(data);
    return updated;
  }

  private async read(): Promise<ReminderFile> {
    if (!existsSync(this.filePath)) return { reminders: [] };
    try {
      return parseReminderFile(await readFile(this.filePath, 'utf-8'));
    } catch {
      return { reminders: [] };
    }
  }

  private async write(data: ReminderFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await rename(tmp, this.filePath);
  }
}
