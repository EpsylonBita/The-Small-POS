import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupportCode, SupportView } from '../../hooks/useSupportSession';

export function supportCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function SupportCodeScreen({ view, code, remainingMs, busy, onRetry, onCancel }: {
  view: SupportView; code: SupportCode | null; remainingMs: number; busy: boolean;
  onRetry(): void; onCancel(): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const issued = view === 'code' && code !== null && remainingMs > 0;
  const message = view === 'offline' ? 'code.needsInternet' : view === 'staff_required' ? 'staff.required'
    : view === 'sign_in_again' ? 'staff.signInAgain' : view === 'expired' || (view === 'code' && !issued)
      ? 'code.expired' : view === 'loading' ? 'code.loading' : 'code.retry';
  return <section data-support-secret aria-labelledby={titleId} className="space-y-4 rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg)">
    <h3 id={titleId} className="text-lg font-bold">{t('support.connect.action')}</h3>
    {issued && code ? <>
      <p>{code.terminal_name}</p>
      <p aria-label={t('support.code.label')} className="select-text break-words font-mono text-3xl font-bold tracking-widest">{code.code}</p>
      <SupportQrCode url={code.qr_url} label={t('support.code.qr')} />
      <p role="timer" aria-label={t('support.code.timeLeft')}>{supportCountdown(remainingMs)}</p>
      <p>{t('support.code.warning')}</p>
    </> : <p role={view === 'error' ? 'alert' : 'status'}>{t(`support.${message}`)}</p>}
    <div className="flex flex-wrap gap-3">
      {!issued && view !== 'loading' && <button type="button" disabled={busy} onClick={onRetry}
        className="min-h-[48px] min-w-[48px] rounded-xl bg-(--pos-s-sel-bg) px-4 font-semibold text-(--pos-s-sel-fg) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60">
        {t('support.code.newCode')}
      </button>}
      <button type="button" onClick={onCancel}
        className="min-h-[48px] min-w-[48px] rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2">
        {t('support.code.cancel')}
      </button>
    </div>
  </section>;
}

/*
The MIT License (MIT)

Copyright (c) 2012 Ryan Day
Copyright (c) 2009 Kazuhiko Arase (original QRCode for JavaScript)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/
/** Local byte-mode QR, level L / mask 0. No canvas, native encoder or remote service.
 * QR layout/tables adapted from qrcode 1.5.4 (MIT); license below.
 */
const versions = [
  [26, 7, 1], [44, 10, 1], [70, 15, 1], [100, 20, 1], [134, 26, 1], [172, 36, 2], [196, 40, 2], [242, 48, 2], [292, 60, 2], [346, 72, 4],
  [404, 80, 4], [466, 96, 4], [532, 104, 4], [581, 120, 4], [655, 132, 6], [733, 144, 6], [815, 168, 6], [901, 180, 6], [991, 196, 7], [1085, 224, 8],
  [1156, 224, 8], [1258, 252, 9], [1364, 270, 9], [1474, 300, 10], [1588, 312, 12], [1706, 336, 12], [1828, 360, 12], [1921, 390, 13], [2051, 420, 14], [2185, 450, 15],
  [2323, 480, 16], [2465, 510, 17], [2611, 540, 18], [2761, 570, 19], [2876, 570, 19], [3034, 600, 20], [3196, 630, 21], [3362, 660, 22], [3532, 720, 24], [3706, 750, 25],
] as const
function multiply(left: number, right: number): number {
  let result = 0
  for (; right; right >>>= 1) {
    if (right & 1) { result ^= left }
    left <<= 1
    if (left & 256) { left ^= 0x11d }
  }
  return result
}
function correction(data: number[], degree: number): number[] {
  let polynomial = [1]
  let root = 1
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(polynomial.length + 1).fill(0)
    polynomial.forEach((value, index) => { next[index] ^= value; next[index + 1] ^= multiply(value, root) })
    polynomial = next; root = multiply(root, 2)
  }
  const remainder = [...data, ...new Array<number>(degree).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = remainder[i]
    polynomial.forEach((value, index) => { remainder[i + index] ^= multiply(value, factor) })
  }
  return remainder.slice(data.length)
}
function bch(value: number, polynomial: number): number {
  let remainder = value
  const bits = (number: number) => number === 0 ? 0 : 32 - Math.clz32(number)
  while (bits(remainder) >= bits(polynomial)) { remainder ^= polynomial << (bits(remainder) - bits(polynomial)) }
  return remainder
}
export function encodeSupportQr(value: string): { version: number; size: number; cells: number[] } {
  if (!/^[\x20-\x7e]+$/.test(value) || value.length > 2048) { throw new Error('INVALID_QR_INPUT') }
  const index = versions.findIndex(([total, ecc], candidate) => 4 + (candidate < 9 ? 8 : 16) + value.length * 8 <= (total - ecc) * 8)
  if (index < 0) { throw new Error('INVALID_QR_INPUT') }
  const version = index + 1
  const [total, ecc, blockCount] = versions[index]
  const dataCount = total - ecc
  const bits: number[] = []
  const put = (number: number, count: number) => { for (let bit = count - 1; bit >= 0; bit--) { bits.push((number >>> bit) & 1) } }
  put(4, 4); put(value.length, version < 10 ? 8 : 16)
  for (const character of value) { put(character.charCodeAt(0), 8) }
  put(0, Math.min(4, dataCount * 8 - bits.length))
  while (bits.length % 8) { bits.push(0) }
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) { bytes.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0)) }
  for (let pad = 0; bytes.length < dataCount; pad++) { bytes.push(pad % 2 ? 0x11 : 0xec) }
  const shortBlocks = blockCount - total % blockCount
  const blocks: number[][] = []
  const corrections: number[][] = []
  let offset = 0
  for (let block = 0; block < blockCount; block++) {
    const count = Math.floor(dataCount / blockCount) + (block < shortBlocks ? 0 : 1)
    const data = bytes.slice(offset, offset + count)
    blocks.push(data); corrections.push(correction(data, ecc / blockCount)); offset += count
  }
  const interleaved: number[] = []
  for (let i = 0; i < Math.ceil(dataCount / blockCount); i++) { blocks.forEach(block => { if (i < block.length) { interleaved.push(block[i]) } }) }
  for (let i = 0; i < ecc / blockCount; i++) { corrections.forEach(block => interleaved.push(block[i])) }
  const size = version * 4 + 17
  const cells = new Array<number>(size * size).fill(0)
  const reserved = new Array<boolean>(size * size).fill(false)
  const set = (row: number, column: number, dark: number | boolean) => {
    if (row >= 0 && column >= 0 && row < size && column < size) { cells[row * size + column] = Number(dark); reserved[row * size + column] = true }
  }
  for (const [row, column] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) { set(row + r, column + c, (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) }
    }
  }
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0) }
  if (version > 1) {
    const count = Math.floor(version / 7) + 2
    const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2
    const positions = [size - 7]
    for (let i = 1; i < count - 1; i++) { positions.push(positions[i - 1] - interval) }
    positions.push(6); positions.reverse()
    positions.forEach((row, r) => positions.forEach((column, c) => {
      if ((r === 0 && (c === 0 || c === count - 1)) || (r === count - 1 && c === 0)) { return }
      for (let y = -2; y <= 2; y++) { for (let x = -2; x <= 2; x++) { set(row + y, column + x, Math.abs(x) === 2 || Math.abs(y) === 2 || (x === 0 && y === 0)) } }
    }))
  }
  const format = ((8 << 10) | bch(8 << 10, 0x537)) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const bit = (format >>> i) & 1
    set(i < 6 ? i : i < 8 ? i + 1 : size - 15 + i, 8, bit)
    set(8, i < 8 ? size - i - 1 : i === 8 ? 7 : 14 - i, bit)
  }
  set(size - 8, 8, 1)
  if (version >= 7) {
    const encoded = (version << 12) | bch(version << 12, 0x1f25)
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3), column = i % 3 + size - 11, bit = (encoded >>> i) & 1
      set(row, column, bit); set(column, row, bit)
    }
  }
  let row = size - 1, direction = -1, dataBit = 0
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) { column-- }
    while (true) {
      for (let c = 0; c < 2; c++) {
        const position = row * size + column - c
        if (!reserved[position]) {
          const bit = ((interleaved[Math.floor(dataBit / 8)] ?? 0) >>> (7 - dataBit % 8)) & 1
          cells[position] = bit ^ Number((row + column - c) % 2 === 0); dataBit++
        }
      }
      row += direction
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break }
    }
  }
  return { version, size, cells }
}

function SupportQrCode({ url, label }: { url: string; label: string }) {
  const qr = useMemo(() => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search
        || parsed.pathname !== '/admin/support/connect' || !/^#(?:c=)?[A-Z0-9-]{8,9}$/.test(parsed.hash)) { return null; }
      return encodeSupportQr(parsed.href);
    } catch { return null; }
  }, [url]);
  if (!qr) { return null; }
  const path = qr.cells.flatMap((dark, index) => dark ? [`M${index % qr.size + 4} ${Math.floor(index / qr.size) + 4}h1v1h-1z`] : []).join('');
  return <svg role="img" aria-label={label} width={192} height={192} viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
    className="h-48 w-48 max-w-full bg-white" shapeRendering="crispEdges">
    <rect width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
    <path d={path} fill="#000000" />
  </svg>;
}
