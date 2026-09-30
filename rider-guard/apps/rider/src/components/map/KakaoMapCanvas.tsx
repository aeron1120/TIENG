/**
 * 카카오 지도 (Kakao Maps JavaScript SDK) — 웹 전용.
 * SDK 는 카카오 개발자 콘솔에 등록한 사이트 도메인에서만 동작한다. 안드로이드 웹뷰(file://)는 도메인이 없어
 * RiderMap 이 웹에서만 이 컴포넌트를 쓰고, 네이티브는 MapLibre(MapCanvas) 를 그대로 쓴다.
 *
 * 조작 없는 미리보기(드래그·줌 끔), 위치를 가운데에. 핀·말풍선·알약은 RN 쪽(RiderMap)이 위에 겹쳐 그린다.
 * 카카오 로고·저작권 표시는 약관상 가리면 안 되므로 오른쪽 아래로 옮긴다 — 왼쪽 아래는 RiderMap 알약 자리다.
 */
import { useEffect, useRef } from 'react';

import type { MapCanvasStatus } from '@/components/map/MapCanvas';

/** 여기서 쓰는 SDK 부분만 */
type KakaoLatLng = object;
type KakaoMap = {
  setCenter(at: KakaoLatLng): void;
  panTo(at: KakaoLatLng): void;
  setLevel(level: number): void;
  relayout(): void;
  setCopyrightPosition(position: number, reversed?: boolean): void;
};
type KakaoMaps = {
  load(cb: () => void): void;
  LatLng: new (lat: number, lng: number) => KakaoLatLng;
  Map: new (el: HTMLElement, options: Record<string, unknown>) => KakaoMap;
  CopyrightPosition: { BOTTOMRIGHT: number };
  event: { addListener(target: KakaoMap, type: string, cb: () => void): void };
};
declare global {
  interface Window {
    kakao?: { maps: KakaoMaps };
  }
}

type Props = {
  lat: number;
  lng: number;
  /** MapLibre 줌 (RiderMap 과 같은 값). 카카오 레벨로 바꿔 쓴다 */
  zoom: number;
  appKey: string;
  onStatus?: (status: MapCanvasStatus, detail?: string) => void;
};

const LOAD_TIMEOUT_MS = 12_000;

/** MapLibre 줌 15.6 ≈ 카카오 레벨 3 (레벨이 작을수록 가깝다, 1~14) */
const levelOf = (zoom: number) => Math.min(14, Math.max(1, Math.round(19 - zoom)));

/** SDK 는 페이지에 한 번만 — 여러 지도가 같은 로드를 기다린다 */
let sdk: Promise<KakaoMaps> | null = null;
function loadSdk(appKey: string): Promise<KakaoMaps> {
  sdk ??= new Promise<KakaoMaps>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    script.async = true;
    script.onload = () => {
      const maps = window.kakao?.maps;
      if (!maps) return reject(new Error('kakao sdk missing'));
      maps.load(() => resolve(maps));
    };
    script.onerror = () => reject(new Error('kakao sdk load failed'));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    // 다음 지도에서 다시 시도할 수 있게
    sdk = null;
    throw err;
  });
  return sdk;
}

export default function KakaoMapCanvas({ lat, lng, zoom, appKey, onStatus }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<KakaoMap | null>(null);
  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  }, [onStatus]);
  // SDK 를 받는 사이 위치가 바뀌어도 최신 위치로 만든다
  const latest = useRef({ lat, lng, zoom });

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let cancelled = false;
    let settled = false;
    const settle = (status: MapCanvasStatus, detail?: string) => {
      if (settled || cancelled) return;
      settled = true;
      report.current?.(status, detail);
    };
    // 도메인 미등록·키 오류면 SDK 는 뜨지만 타일이 오지 않는다 — 시간 안에 타일이 안 오면 실패로 본다
    const timer = setTimeout(() => settle('error', 'timeout'), LOAD_TIMEOUT_MS);

    loadSdk(appKey)
      .then((maps) => {
        if (cancelled) return;
        const at = latest.current;
        const m = new maps.Map(el, {
          center: new maps.LatLng(at.lat, at.lng),
          level: levelOf(at.zoom),
          draggable: false,
          scrollwheel: false,
          disableDoubleClick: true,
          disableDoubleClickZoom: true,
          keyboardShortcuts: false,
        });
        m.setCopyrightPosition(maps.CopyrightPosition.BOTTOMRIGHT, true);
        map.current = m;
        maps.event.addListener(m, 'tilesloaded', () => {
          clearTimeout(timer);
          settle('ready');
        });
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        settle('error', err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      map.current = null;
      el.replaceChildren();
    };
  }, [appKey]);

  // 위치가 바뀌면 가운데를 옮긴다 (줄임 모션이면 바로)
  useEffect(() => {
    latest.current = { lat, lng, zoom };
    const m = map.current;
    const maps = window.kakao?.maps;
    if (!m || !maps) return;
    const at = new maps.LatLng(lat, lng);
    m.setLevel(levelOf(zoom));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) m.setCenter(at);
    else m.panTo(at);
  }, [lat, lng, zoom]);

  return <div ref={holder} aria-hidden style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' }} />;
}
