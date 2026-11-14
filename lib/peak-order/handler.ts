import 'server-only';
import type { InboundMessage } from '@/lib/ai-quote/channels/types';
import type { CreateOrderBody, CreateOrderResult, OrderActor } from '@/lib/orders-create';
import type { PeakQuotation, PeakReader } from '@/lib/peak/read';
import { PeakAuthError, PeakUnavailableError } from '@/lib/peak/oauth';
import { PeakNotConnectedError } from '@/lib/peak/token-store';
import { PeakToolError } from '@/lib/peak/mcp-client';
import { PeakConfigError } from '@/lib/peak/crypto';
import type { DraftRow, DraftStep, PeakOrderDb } from '@/lib/peak-order/db';
import { orderCommandArgs, parseOrderCommand } from '@/lib/peak-order/command';
import { resolveOrderCommand } from '@/lib/peak-order/resolve';
import { bangkokISODate, firstLine, planUnits } from '@/lib/peak-order/mapper';
import { TEXT, choicesCard, modeCard, statusCard, unitCard, whoCard, type Card } from '@/lib/peak-order/flex';

/**
 * Orchestration of the LINE /order flow (spec §4, §6.5).
 * Task 12: command entry — identity, resolve, status card, draft start.
 *
 * Every refused path (no userId, unknown user, Voided, zero lines, status
 * card) replies without creating a draft row. Peak is only called after the
 * identity checks pass. Known Peak failures are answered with short text and
 * never thrown; anything else propagates.
 */

export interface PeakOrderDeps {
  /** Flex-or-text fallback lives in the wiring (Task 14). */
  reply: (m: InboundMessage, card: Card | string | Array<Card | string>) => Promise<void>;
  peak: PeakReader;
  db: PeakOrderDb;
  createOrder: (body: CreateOrderBody, actor: OrderActor) => Promise<CreateOrderResult>;
  getDisplayName: (lineUserId: string) => Promise<string | null>;
  now: () => Date;
  newDraftId: () => string;
}

export const DRAFT_TTL_MS = 30 * 60_000;

/**
 * Short reply text for a known Peak failure, or null when `e` is not one.
 * PeakConfigError = stored token cannot be decrypted (bad/missing key) → treated
 * as "not connected" so the connection never dies silently (ruling R2).
 */
export function peakFailureText(e: unknown): string | null {
  if (e instanceof PeakNotConnectedError || e instanceof PeakAuthError || e instanceof PeakConfigError) {
    return TEXT.peakNotConnected;
  }
  if (e instanceof PeakUnavailableError || e instanceof PeakToolError) return TEXT.peakUnavailable;
  return null;
}

function logPeakFailure(where: string, e: unknown): void {
  // Error class name only — never the message (keeps any upstream detail out of logs).
  console.warn(`[peak-order] ${where}: ${e instanceof Error ? e.name : 'unknown error'}`);
}

export async function handlePeakOrderText(m: InboundMessage, deps: PeakOrderDeps): Promise<void> {
  const uid = m.channelUserId;
  if (!uid) {
    await deps.reply(m, TEXT.noUser);
    return;
  }
  const text = m.text ?? '';
  const staff = await deps.db.getStaff(uid);
  if (!staff) {
    await deps.reply(m, whoCard(orderCommandArgs(text)));
    return;
  }
  const cmd = parseOrderCommand(text);
  if (!cmd) return; // not an /order command — the router never sends these

  let resolved: Awaited<ReturnType<typeof resolveOrderCommand>>;
  try {
    resolved = await resolveOrderCommand(cmd, {
      peak: deps.peak,
      openedCodes: (codes) => deps.db.openedCodes(codes),
      todayISO: bangkokISODate(deps.now()),
    });
  } catch (e) {
    const msg = peakFailureText(e);
    if (msg === null) throw e;
    logPeakFailure('resolve', e);
    await deps.reply(m, msg);
    return;
  }

  switch (resolved.kind) {
    case 'not-found':
      await deps.reply(m, resolved.hint);
      return;
    case 'choices':
      await deps.reply(m, choicesCard(resolved.heading, resolved.choices, resolved.note));
      return;
    case 'quotation':
      await startFromQuotation(m, deps, resolved.quotation, resolved.customerName, staff.orderer);
      return;
  }
}

/**
 * Start a draft for one quotation (also the entry for the `pick` / `rest`
 * postbacks). Lines with a live link to a line key that still exists in the
 * quotation are taken; link rows for keys no longer in the quotation are
 * ignored. Any taken line without `remainingOnly` → status card, no draft.
 */
export async function startFromQuotation(
  m: InboundMessage,
  deps: PeakOrderDeps,
  q: PeakQuotation,
  customerName: string,
  orderer: string,
  opts: { remainingOnly?: boolean } = {},
): Promise<void> {
  const uid = m.channelUserId;
  if (!uid) {
    await deps.reply(m, TEXT.noUser);
    return;
  }
  if (q.status.trim().toLowerCase() === 'voided') {
    await deps.reply(m, TEXT.voided);
    return;
  }
  if (q.lines.length === 0) {
    await deps.reply(m, TEXT.noLines);
    return;
  }

  const live = await deps.db.liveLinks(q.code);
  const currentKeys = new Set(q.lines.map((l) => l.key));
  const liveHere = live.filter((l) => currentKeys.has(l.lineKey));
  const liveKeys = new Set(liveHere.map((l) => l.lineKey));
  const free = q.lines.filter((l) => !liveKeys.has(l.key));

  // Already (partly) opened and not asked for the rest — or nothing left to open.
  if ((liveKeys.size > 0 && !opts.remainingOnly) || free.length === 0) {
    const opened: Array<{ orderId: number; name: string; isDraft: boolean }> = [];
    const seen = new Set<number>();
    for (const l of liveHere) {
      // An in-flight claim (orderId null) makes its line "not free" but is not an opened order (R4).
      if (l.orderId === null || seen.has(l.orderId)) continue;
      seen.add(l.orderId);
      opened.push({ orderId: l.orderId, name: l.orderName ?? '', isDraft: l.orderStatus === 'draft' });
    }
    await deps.reply(
      m,
      statusCard({
        qoCode: q.code,
        customerName,
        opened,
        remaining: free.map((l) => ({ name: firstLine(l.description) })),
      }),
    );
    return;
  }

  let mode: DraftRow['mode'];
  let units: DraftRow['units'];
  let step: DraftStep;
  if (free.length === 1 && q.lines.length === 1) {
    mode = 'single';
    units = planUnits(q, 'single').map((u) => ({ ...u, choices: {} }));
    step = 'unit';
  } else if (opts.remainingOnly || free.length !== q.lines.length) {
    mode = 'split';
    units = planUnits(
      q,
      'split',
      free.map((l) => l.key),
    ).map((u) => ({ ...u, choices: {} }));
    step = 'unit';
  } else {
    mode = null;
    units = [];
    step = 'mode';
  }

  const row: Omit<DraftRow, 'lastTouchedAt' | 'creatingKind'> = {
    id: deps.newDraftId(),
    groupId: m.groupId ?? '',
    lineUserId: uid,
    orderer,
    qoCode: q.code,
    snapshot: { quotation: structuredClone(q), customerName },
    mode,
    units,
    unitIdx: 0,
    step,
  };
  await deps.db.createDraft(row);
  const draft: DraftRow = { ...row, creatingKind: null, lastTouchedAt: deps.now().toISOString() };
  await deps.reply(m, step === 'mode' ? modeCard(draft) : unitCard(draft));
}
