import { describe, expect, it } from 'vitest';
import type { PeakQuotation, PeakQuotationRow, PeakReader } from '@/lib/peak/read';
import { resolveOrderCommand } from '@/lib/peak-order/resolve';

const row = (n: number, contactCode = 'C1'): PeakQuotationRow => ({
  code: `QO-2026090${String(n).padStart(4, '0')}`,
  issuedDate: '2026-11-01',
  contactCode,
  netAmount: 100 * n,
});
const quot = (r: PeakQuotationRow, desc = `งาน ${r.code}`): PeakQuotation => ({
  ...r,
  status: 'approved',
  lines: [{ key: 'k1', description: desc, quantity: 10, price: 1 }],
});

type Call = { m: string; a: unknown[] };
function fake(over: Partial<PeakReader> = {}) {
  const calls: Call[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const wrap = <T>(m: string, fn: (...a: never[]) => Promise<T>) =>
    (async (...a: never[]) => {
      calls.push({ m, a });
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        return await fn(...a);
      } finally {
        inflight--;
      }
    }) as never;
  const base: PeakReader = {
    getQuotation: wrap('getQuotation', async () => null),
    listQuotations: wrap('listQuotations', async () => ({ rows: [], total: 0 })),
    newestQuotations: wrap('newestQuotations', async () => []),
    getContactName: wrap('getContactName', async () => null),
  };
  const reader = { ...base } as PeakReader;
  for (const k of Object.keys(over) as (keyof PeakReader)[]) {
    (reader as unknown as Record<string, unknown>)[k] = wrap(k, over[k] as never);
  }
  return { reader, calls, max: () => maxInflight, count: (m: string) => calls.filter((c) => c.m === m).length };
}
const opened = (s: string[] = []) => async () => new Set(s);
const TODAY = '2026-11-14';

describe('resolveOrderCommand', () => {
  it('latest -> 5 newest from today-30d as choices', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    const f = fake({
      newestQuotations: async () => rows,
      getQuotation: async (c: string) => quot(rows.find((r) => r.code === c)!),
      getContactName: async () => 'ไทยฟูดส์',
    });
    const r = await resolveOrderCommand({ kind: 'latest' }, { peak: f.reader, openedCodes: opened([rows[1].code]), todayISO: TODAY });
    expect(f.calls.find((c) => c.m === 'newestQuotations')!.a).toEqual([{ dateStart: '2026-10-15' }, 5]);
    if (r.kind !== 'choices') throw new Error('expected choices');
    expect(r.heading).toContain('5 ใบล่าสุด');
    expect(r.choices).toHaveLength(5);
    expect(r.choices[0]).toMatchObject({ customerName: 'ไทยฟูดส์', firstLine: `งาน ${rows[0].code}`, opened: false });
    expect(r.choices[1].opened).toBe(true);
    expect(f.count('getContactName')).toBe(1);
  });

  it('latest with none -> not-found', async () => {
    const f = fake();
    const r = await resolveOrderCommand({ kind: 'latest' }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(r.kind).toBe('not-found');
  });

  it('code found -> quotation with customer name; contact code fallback', async () => {
    const q = quot(row(97));
    const f = fake({ getQuotation: async () => q });
    const r = await resolveOrderCommand({ kind: 'code', code: q.code }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(r).toEqual({ kind: 'quotation', quotation: q, customerName: 'C1' });
  });

  it('code not found falls back to digits search', async () => {
    const q = quot(row(97));
    const f = fake({
      getQuotation: async (c: string) => (c === q.code ? q : null),
      listQuotations: async () => ({ rows: [row(97)], total: 1 }),
      getContactName: async () => 'ลูกค้า',
    });
    const r = await resolveOrderCommand({ kind: 'code', code: 'QO-20269999999' }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(f.calls.find((c) => c.m === 'listQuotations')!.a).toEqual([{ searchText: '20269999999', page: 1 }]);
    expect(r).toMatchObject({ kind: 'quotation', customerName: 'ลูกค้า' });
  });

  it('code not found and digits find nothing -> not-found', async () => {
    const f = fake();
    const r = await resolveOrderCommand({ kind: 'code', code: 'QO-20269999999' }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(r.kind).toBe('not-found');
  });

  it('digits: 0 -> not-found, 1 -> quotation, many -> choices', async () => {
    const q = quot(row(1));
    let total = 0;
    const f = fake({
      listQuotations: async () => ({ rows: total ? [row(1)] : [], total }),
      getQuotation: async () => q,
      newestQuotations: async () => [row(1), row(2)],
    });
    const d = { peak: f.reader, openedCodes: opened(), todayISO: TODAY };
    expect((await resolveOrderCommand({ kind: 'digits', digits: '900' }, d)).kind).toBe('not-found');
    total = 1;
    expect((await resolveOrderCommand({ kind: 'digits', digits: '900' }, d)).kind).toBe('quotation');
    total = 7;
    const r = await resolveOrderCommand({ kind: 'digits', digits: '900' }, d);
    expect(r.kind).toBe('choices');
    if (r.kind === 'choices') expect(r.choices).toHaveLength(2);
  });

  it('text: longest matching prefix wins; remaining words filter descriptions', async () => {
    const rows = [row(1), row(2), row(3)];
    const descs: Record<string, string> = { [rows[0].code]: 'ป้ายไวนิล 1x2', [rows[1].code]: 'สติกเกอร์', [rows[2].code]: 'ไวนิล  ขนาด 1x2' };
    const f = fake({
      listQuotations: async (q: { searchText?: string }) =>
        q.searchText === 'ไทยฟูดส์ อาหารสัตว์' ? { rows, total: 3 } : { rows: [], total: 0 },
      newestQuotations: async () => rows,
      getQuotation: async (c: string) => quot(rows.find((r) => r.code === c)!, descs[c]),
    });
    const d = { peak: f.reader, openedCodes: opened(), todayISO: TODAY };
    const r = await resolveOrderCommand({ kind: 'text', words: ['ไทยฟูดส์', 'อาหารสัตว์', 'ไวนิล'] }, d);
    const searches = f.calls.filter((c) => c.m === 'listQuotations').map((c) => (c.a[0] as { searchText: string }).searchText);
    expect(searches).toEqual(['ไทยฟูดส์ อาหารสัตว์ ไวนิล', 'ไทยฟูดส์ อาหารสัตว์']);
    expect(f.calls.find((c) => c.m === 'newestQuotations')!.a).toEqual([{ searchText: 'ไทยฟูดส์ อาหารสัตว์' }, 20]);
    if (r.kind !== 'choices') throw new Error('expected choices');
    expect(r.choices.map((c) => c.code)).toEqual([rows[0].code, rows[2].code]);
    expect(r.note).toBeUndefined();

    // whitespace-normalised, every filter word required
    const r2 = await resolveOrderCommand({ kind: 'text', words: ['ไทยฟูดส์', 'อาหารสัตว์', 'ไวนิล', '1x2'] }, d);
    if (r2.kind !== 'choices') throw new Error('expected choices');
    expect(r2.choices).toHaveLength(2);
  });

  it('text: no survivor -> 5 unfiltered with a note', async () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(n));
    const f = fake({
      listQuotations: async (q: { searchText?: string }) => (q.searchText === 'abc' ? { rows, total: 6 } : { rows: [], total: 0 }),
      newestQuotations: async () => rows,
      getQuotation: async (c: string) => quot(rows.find((r) => r.code === c)!, 'สติกเกอร์'),
    });
    const r = await resolveOrderCommand({ kind: 'text', words: ['abc', 'ไวนิล'] }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    if (r.kind !== 'choices') throw new Error('expected choices');
    expect(r.choices).toHaveLength(5);
    expect(r.note).toContain('ไวนิล');
  });

  it('text: no prefix matches -> not-found; single match -> quotation', async () => {
    const f = fake();
    const nf = await resolveOrderCommand({ kind: 'text', words: ['x', 'y'] }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(nf.kind).toBe('not-found');
    expect(f.count('listQuotations')).toBe(2);
    const g = fake({
      listQuotations: async () => ({ rows: [row(5)], total: 1 }),
      getQuotation: async () => quot(row(5)),
    });
    const one = await resolveOrderCommand({ kind: 'text', words: ['x'] }, { peak: g.reader, openedCodes: opened(), todayISO: TODAY });
    expect(one.kind).toBe('quotation');
  });

  it('contact name fetched once for two quotations of the same customer', async () => {
    const rows = [row(1, 'CX'), row(2, 'CX')];
    const f = fake({
      newestQuotations: async () => rows,
      getQuotation: async (c: string) => quot(rows.find((r) => r.code === c)!),
      getContactName: async () => 'ลูกค้า X',
    });
    const r = await resolveOrderCommand({ kind: 'latest' }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(f.count('getContactName')).toBe(1);
    if (r.kind === 'choices') expect(r.choices.every((c) => c.customerName === 'ลูกค้า X')).toBe(true);
  });

  it('hard cap: counts every Peak call and stops fetching past the cap', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => row(i + 1, `C${i + 1}`));
    const mk = () =>
      fake({
        listQuotations: async (q: { searchText?: string }) => (q.searchText === 'a' ? { rows: pool, total: 20 } : { rows: [], total: 0 }),
        newestQuotations: async () => pool,
        getQuotation: async (c: string) => quot(pool.find((r) => r.code === c)!, 'ไวนิล'),
        getContactName: async () => 'n',
      });
    const words = ['a', 'ไวนิล'];
    // production limits: the heaviest path stays within 40
    const f = mk();
    await resolveOrderCommand({ kind: 'text', words }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(f.calls.length).toBeLessThanOrEqual(40);
    // forced low cap: exactly maxCalls reach the reader
    const g = mk();
    const r = await resolveOrderCommand({ kind: 'text', words }, { peak: g.reader, openedCodes: opened(), todayISO: TODAY, limits: { maxCalls: 10 } });
    expect(g.calls.length).toBe(10);
    expect(r.kind).toBe('choices');
  });

  it('concurrency never exceeds 3', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => row(i + 1, `C${i + 1}`));
    const f = fake({
      listQuotations: async (q: { searchText?: string }) => (q.searchText === 'a' ? { rows: pool, total: 20 } : { rows: [], total: 0 }),
      newestQuotations: async () => pool,
      getQuotation: async (c: string) => quot(pool.find((r) => r.code === c)!, 'ไวนิล'),
      getContactName: async () => 'n',
    });
    await resolveOrderCommand({ kind: 'text', words: ['a', 'ไวนิล'] }, { peak: f.reader, openedCodes: opened(), todayISO: TODAY });
    expect(f.max()).toBeGreaterThan(1);
    expect(f.max()).toBeLessThanOrEqual(3);
  });
});
