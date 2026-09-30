import type { SensorMetadata, SensorSample } from '@rider-guard/contract';

/**
 * 보고서 대표 사례(D6·B3·C3)를 흉내 낸 mock fixture. PDF 요약값의 모양만 따른 합성 시계열이며
 * 실측 재생이 아니다 — dataSource 는 늘 'mock' 이고 provenance 에 그 사실을 적는다.
 * 1kHz, 1.2초. 피크 모양은 가우시안 펄스로 단순화했다.
 */
export type MockCaseId = 'D6' | 'B3' | 'C3';
export type MockCase = { id: MockCaseId; title: string; expect: string; samples: SensorSample[]; sensorMetadata: SensorMetadata };

const RATE_HZ = 1000;
const DURATION_S = 1.2;
const pulse = (t: number, at: number, widthS: number, height: number) => height * Math.exp(-(((t - at) / widthS) ** 2));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function metadata(id: MockCaseId): SensorMetadata {
  return {
    dataSource: 'mock',
    sampleRateHz: RATE_HZ,
    accRangeG: 16,
    gyroRangeDps: 2000,
    filter: null,
    calibration: null,
    mount: null,
    provenance: `${id} mock fixture — 보고서 요약값 모양을 흉내 낸 합성 시계열. 실측 재생 아님`,
  };
}

function series(fn: (t: number) => Omit<SensorSample, 't' | 'seq'>, drop?: { from: number; to: number }): SensorSample[] {
  const out: SensorSample[] = [];
  for (let i = 0; i <= DURATION_S * RATE_HZ; i++) {
    const t = round(i / RATE_HZ);
    if (drop && t >= drop.from && t < drop.to) continue; // 패킷 누락: 순번도 함께 건너뛴다
    out.push({ t, seq: i, ...fn(t) });
  }
  return out;
}

export const MOCK_CASES: Record<MockCaseId, () => MockCase> = {
  // 정상 연석 통과: 각속도는 300°/s 를 넘지만 가속도가 약 3.5g 라 후보가 아니어야 한다
  D6: () => ({
    id: 'D6',
    title: 'D6 정상 연석 통과 (mock)',
    expect: 'no_candidate',
    sensorMetadata: metadata('D6'),
    samples: series((t) => ({
      accG: round(1 + pulse(t, 0.5, 0.02, 2.5)),
      gyroDps: round(pulse(t, 0.52, 0.04, 420), 1),
      bankDeg: round(pulse(t, 0.55, 0.08, 12), 2),
      dv150: round(pulse(t, 0.55, 0.06, 0.8)),
      dvValid: true,
    })),
  }),
  // 정지 중 후방 피추돌: 주행 속도 0, 차체 전도 없음(뱅크각 작음)이어도 가속도+ΔV 로 후보가 나와야 한다
  B3: () => ({
    id: 'B3',
    title: 'B3 정지 중 후방 피추돌 (mock)',
    expect: 'candidate',
    sensorMetadata: metadata('B3'),
    samples: series((t) => ({
      accG: round(1 + pulse(t, 0.6, 0.015, 8)),
      gyroDps: round(pulse(t, 0.62, 0.05, 240), 1),
      bankDeg: round(pulse(t, 0.65, 0.1, 6), 2),
      dv150: round(pulse(t, 0.66, 0.05, 3.4)),
      dvValid: true,
    })),
  }),
  // 충격 구간 누락: 가속도·각속도로 후보가 나오고, 누락을 가로지르는 ΔV 는 무효로 남아야 한다
  C3: () => {
    const drop = { from: 0.49, to: 0.53 };
    return {
      id: 'C3',
      title: 'C3 충격 구간 패킷 누락 (mock)',
      expect: 'candidate + dv invalid',
      sensorMetadata: metadata('C3'),
      samples: series((t) => {
        const crossesGap = t >= drop.from && t < drop.to + 0.15;
        return {
          accG: round(1 + pulse(t, 0.535, 0.02, 11)),
          gyroDps: round(pulse(t, 0.54, 0.04, 520), 1),
          bankDeg: round(pulse(t, 0.6, 0.1, 20), 2),
          dv150: crossesGap ? null : round(pulse(t, 0.4, 0.05, 0.5)),
          dvValid: !crossesGap,
          dvInvalidReason: crossesGap ? 'packet_gap' : null,
        };
      }, drop),
    };
  },
};
