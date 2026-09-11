/**
 * 时区工具 —— 东八区日期键
 *
 * 铁律（docs/01 §4.1、docs/03 §7）：所有日期计算显式用 Asia/Shanghai，
 * 不依赖运行环境 TZ（部署虽然会设 TZ=Asia/Shanghai，代码必须有兜底）。
 *
 * 用 formatToParts 手工拼装，避免依赖具体 locale 的分隔符差异。
 */

export const TZ = 'Asia/Shanghai'

/** 缓存 DateTimeFormat：构造开销不小，且进程内时区固定 */
const dateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const timeParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const p = parts.find((x) => x.type === type)
  if (!p) throw new Error(`Intl.DateTimeFormat missing part: ${type}`)
  return p.value
}

/** 东八区日期键 "2026-09-08" —— 快照主键的一半 */
export function todayKey(now: number = Date.now()): string {
  const parts = dateParts.formatToParts(now)
  return `${pick(parts, 'year')}-${pick(parts, 'month')}-${pick(parts, 'day')}`
}

/** 东八区 "HH:mm:ss"（日志用） */
export function nowClock(now: number = Date.now()): string {
  const p = timeParts.formatToParts(now)
  return `${pick(p, 'hour')}:${pick(p, 'minute')}:${pick(p, 'second')}`
}

/** ISO 字符串，带时区偏移信息，落库用 */
export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString()
}

/** 解析 ISO 串为毫秒；坏值返回 NaN，调用方自行兜底 */
export function parseIso(s: string | null | undefined): number {
  if (!s) return NaN
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : NaN
}

/** 相差 N 天的日期键（N 可为负），用于按日清理 */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) throw new Error(`bad dateKey: ${dateKey}`)
  // 用 UTC 中午做基准，避开夏令时/跨时区边界抖动（东八区无 DST，这里是保守写法）
  const base = Date.UTC(y, m - 1, d, 12, 0, 0)
  return todayKey(base + days * 86_400_000)
}

/** 秒级 Unix 时间戳 —— 知乎 X-Request-Timestamp 要求秒级 */
export function unixSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000)
}
