'use client';

import { useState } from 'react';

type TestResult =
  | { ok: true; latestCode: string | null; ms: number }
  | { ok: false; error: string };

export function PeakClient({ connected }: { connected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [failed, setFailed] = useState(false);

  async function runTest() {
    setBusy(true);
    setFailed(false);
    setResult(null);
    try {
      const res = await fetch('/api/admin/peak/test', { method: 'POST' });
      setResult((await res.json()) as TestResult);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <a
          href="/api/admin/peak/connect"
          className="inline-flex items-center rounded-md bg-[#c8553d] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          เชื่อมต่อ Peak
        </a>
        <button
          type="button"
          onClick={runTest}
          disabled={busy || !connected}
          className="inline-flex items-center rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400 disabled:opacity-50"
        >
          {busy ? 'กำลังทดสอบ…' : 'ทดสอบ'}
        </button>
      </div>
      {failed && <p className="text-sm text-red-700">ทดสอบไม่สำเร็จ ลองใหม่อีกครั้ง</p>}
      {result && (
        <pre className="rounded-md bg-stone-50 border border-stone-200 p-3 text-xs text-stone-700 overflow-x-auto">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
