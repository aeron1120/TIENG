// 사고 기록 파형 그래프용 순수 계산 — React Native 를 가져오지 않아 node --test 로 바로 검증한다.
import type { SensorAnalysis } from '@rider-guard/contract';

export type WavePoint = SensorAnalysis['waveform'][number];
export type WaveField = 'accG' | 'gyroDps' | 'dv150' | 'bankDeg';

export type ChartBox = { width: number; height: number; t0: number; t1: number; yMax: number };

/** 판정은 크기(절댓값)로 하므로 그래프도 크기로 그린다 — 뱅크각은 |값| */
export const magnitudeOf = (p: WavePoint, field: WaveField): number | null => {
  const v = p[field];
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.abs(v);
};

/**
 * 결측(null)·누락/시간 이상(gap)·센서 시각 역행에서 선을 끊는다. 보간하지 않는다.
 * gap 은 "이 표본 앞에서 연속성이 깨졌다"는 뜻이라 그 표본부터 새 선을 시작한다.
 */
export function splitSegments(points: WavePoint[], field: WaveField): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  let lastT = -Infinity;
  for (const p of points) {
    const v = magnitudeOf(p, field);
    // 역행·중복 센서 시각은 어느 자리에 그려야 할지 알 수 없어 표시하지 않는다
    const badTime = !Number.isFinite(p.t) || p.t <= lastT;
    if ((v === null || p.gap || badTime) && cur.length) {
      out.push(cur);
      cur = [];
    }
    if (badTime) continue;
    lastT = p.t;
    if (v !== null) cur.push({ t: p.t, v });
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 화면 픽셀 열마다 최소·최대 표본을 원래 순서대로 남긴다 — 평균을 내지 않으므로 피크가 사라지지 않는다.
 * 열 수보다 표본이 적으면 그대로 둔다.
 */
export function decimate(seg: { t: number; v: number }[], box: ChartBox): { t: number; v: number }[] {
  if (seg.length <= box.width * 2) return seg;
  const span = box.t1 - box.t0 || 1;
  const out: { t: number; v: number }[] = [];
  let col = -1;
  let lo: { t: number; v: number; i: number } | null = null;
  let hi: { t: number; v: number; i: number } | null = null;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo.i === hi.i) out.push(lo);
    else if (lo.i < hi.i) out.push(lo, hi);
    else out.push(hi, lo);
  };
  seg.forEach((p, i) => {
    const c = Math.floor(((p.t - box.t0) / span) * box.width);
    if (c !== col) {
      flush();
      col = c;
      lo = hi = { ...p, i };
      return;
    }
    if (p.v < lo!.v) lo = { ...p, i };
    if (p.v > hi!.v) hi = { ...p, i };
  });
  flush();
  return out.map(({ t, v }) => ({ t, v }));
}

export const xOf = (t: number, box: ChartBox) => ((t - box.t0) / (box.t1 - box.t0 || 1)) * box.width;
export const yOf = (v: number, box: ChartBox) => box.height - (Math.min(v, box.yMax) / (box.yMax || 1)) * box.height;

/** SVG path d 목록 — 선 조각마다 하나. 한 점짜리 조각은 짧은 가로선으로 보인다. */
export function wavePaths(points: WavePoint[], field: WaveField, box: ChartBox): string[] {
  return splitSegments(points, field).map((seg) => {
    const pts = decimate(seg, box);
    const f = (n: number) => n.toFixed(1);
    if (pts.length === 1) {
      const x = xOf(pts[0]!.t, box);
      const y = yOf(pts[0]!.v, box);
      return `M${f(x - 1)} ${f(y)}L${f(x + 1)} ${f(y)}`;
    }
    return pts.map((p, i) => `${i ? 'L' : 'M'}${f(xOf(p.t, box))} ${f(yOf(p.v, box))}`).join('');
  });
}

/** 세로 범위 — 임계선이 늘 보이도록 임계값의 1.25배 이상, 피크가 잘리지 않게 최댓값 이상 */
export function yMaxFor(points: WavePoint[], field: WaveField, threshold: number): number {
  let max = 0;
  for (const p of points) {
    const v = magnitudeOf(p, field);
    if (v !== null && v > max) max = v;
  }
  return Math.max(threshold * 1.25, max * 1.05) || 1;
}

/** 시간 범위 — 센서 시각이 유효한 표본만 */
export function timeRange(points: WavePoint[]): { t0: number; t1: number } | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.t)) continue;
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
  }
  if (t0 === Infinity) return null;
  return t1 > t0 ? { t0, t1 } : { t0: t0 - 0.05, t1: t0 + 0.05 };
}
