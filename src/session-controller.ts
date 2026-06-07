import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import type { Scratchpad } from './scratchpad.js';
import type { EventLog } from './event-log.js';
import { formatLedgerEntry } from './lookout-helpers.js';

export type CurlResult = {
  ok: true;
  curled: true;
  wroteLedger: boolean;
  ledgerPath?: string;
  clearedMessages: number;
  next: string;
} | {
  ok: false;
  error: string;
};

export type RebootRequest = {
  ledgerPath?: string;
  wroteLedger: boolean;
  clearedMessages: number;
  source: 'tool' | 'control';
};

export class SessionController {
  private pendingReboot: RebootRequest | undefined;
  private curledDuringTurn = false;

  constructor(
    private readonly input: {
      cwd: string;
      ledgerPath?: string;
      messages: ModelMessage[];
      scratchpad?: Scratchpad;
      log: EventLog;
      resetPromptState: () => void;
    },
  ) {}

  async curl(soundingId: string, ledgerEntry?: string): Promise<CurlResult> {
    const entry = ledgerEntry?.trim();
    let resolvedLedgerPath: string | undefined;
    let wroteLedger = false;

    if (entry) {
      if (!this.input.ledgerPath?.trim()) {
        return { ok: false, error: 'No ledgerPath is configured for curl.' };
      }
      resolvedLedgerPath = resolve(this.input.cwd, this.input.ledgerPath);
      await mkdir(dirname(resolvedLedgerPath), { recursive: true });
      await appendFile(resolvedLedgerPath, formatLedgerEntry(entry), 'utf8');
      wroteLedger = true;
    }

    const clearedMessages = this.input.messages.length;
    this.input.messages.length = 0;
    this.input.scratchpad?.refreshPromptSnapshot();
    this.input.resetPromptState();
    this.input.log.append({
      type: 'curl',
      at: new Date().toISOString(),
      soundingId,
      ledgerPath: resolvedLedgerPath,
      wroteLedger,
      clearedMessages,
    });
    this.curledDuringTurn = true;

    return {
      ok: true,
      curled: true,
      wroteLedger,
      ledgerPath: resolvedLedgerPath,
      clearedMessages,
      next: 'The next Sounding will begin from cold Watch instructions and fresh context.',
    };
  }

  requestReboot(source: 'tool' | 'control', result: Extract<CurlResult, { ok: true }>): RebootRequest {
    const request: RebootRequest = {
      ledgerPath: result.ledgerPath,
      wroteLedger: result.wroteLedger,
      clearedMessages: result.clearedMessages,
      source,
    };
    this.pendingReboot = request;
    return request;
  }

  consumeRebootRequest(): RebootRequest | undefined {
    const request = this.pendingReboot;
    this.pendingReboot = undefined;
    return request;
  }

  consumeCurlDuringTurn(): boolean {
    const curled = this.curledDuringTurn;
    this.curledDuringTurn = false;
    return curled;
  }
}
