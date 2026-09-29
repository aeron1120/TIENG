'use dom';

/**
 * 실제 지도 (MapLibre GL JS + OpenFreeMap) — Expo DOM 컴포넌트.
 * 웹은 그대로 DOM 에, 안드로이드는 react-native-webview 안에서 같은 코드가 돈다.
 * 조작 없는 미리보기(드래그·줌 끔), 위치를 가운데에. 핀·말풍선·알약·출처 표시는 RN 쪽(RiderMap)이 위에 겹쳐 그린다.
 * 스타일은 OpenFreeMap positron 을 받아 v3 디자인 색(연석 블록 · 흰 도로 · 연초록 공원 · 청회색 강 · 작은 회색 라벨)으로 덮어쓴다.
 */
import type { DOMProps } from 'expo/dom';
import { getVersion, Map as MapLibreMap, setWorkerUrl, type MapOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';

export type MapCanvasPalette = {
  block: string;
  gap: string;
  road: string;
  roadCasing: string;
  building: string;
  buildingLine: string;
  park: string;
  water: string;
  label: string;
  labelHalo: string;
  rail: string;
};

export type MapCanvasStatus = 'ready' | 'error';

type Props = {
  lat: number;
  lng: number;
  zoom: number;
  styleUrl: string;
  palette: MapCanvasPalette;
  /** 지도 준비 · 실패 알림 (네이티브에서는 비동기 다리로 불린다) */
  onStatus?: (status: MapCanvasStatus, detail?: string) => void | Promise<void>;
  dom?: DOMProps;
};

/** 스타일 JSON 중 여기서 만지는 부분만 */
type LayerJson = { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; [key: string]: unknown };
type StyleJson = { layers: LayerJson[]; [key: string]: unknown };

/** 보여 줄 레이어만 남긴다 — 경계선·지명·방패·공항·물 이름은 뺀다 */
const KEEP = new Set([
  'background',
  'park',
  'water',
  'landuse_residential',
  'landcover_wood',
  'waterway',
  'building',
  'tunnel_motorway_casing',
  'tunnel_motorway_inner',
  'road_area_pier',
  'road_pier',
  'highway_path',
  'highway_minor',
  'highway_major_casing',
  'highway_major_inner',
  'highway_major_subtle',
  'highway_motorway_casing',
  'highway_motorway_inner',
  'highway_motorway_subtle',
  'railway_transit',
  'railway_service',
  'railway',
  'highway_motorway_bridge_casing',
  'highway_motorway_bridge_inner',
  'highway-name-major',
]);

const KOREAN_NAME = ['coalesce', ['get', 'name:ko'], ['get', 'name']];

/** positron 레이어 색을 v3 디자인 색으로 바꾼다 */
function paintFor(layer: LayerJson, p: MapCanvasPalette): LayerJson {
  const id = layer.id;
  const paint = { ...(layer.paint ?? {}) };
  const layout = { ...(layer.layout ?? {}) };
  if (id === 'background') paint['background-color'] = p.block;
  else if (id === 'park' || id === 'landcover_wood') {
    paint['fill-color'] = p.park;
    paint['fill-opacity'] = 1;
  } else if (id === 'water') paint['fill-color'] = p.water;
  else if (id === 'waterway') paint['line-color'] = p.water;
  else if (id === 'landuse_residential') {
    paint['fill-color'] = p.block;
    paint['fill-opacity'] = 1;
  } else if (id === 'building') {
    paint['fill-color'] = p.building;
    paint['fill-outline-color'] = p.buildingLine;
  } else if (id === 'highway_minor' || id === 'highway_path' || id === 'road_pier') paint['line-color'] = p.gap;
  else if (id === 'road_area_pier') paint['fill-color'] = p.gap;
  else if (id.endsWith('_casing')) paint['line-color'] = p.roadCasing;
  else if (id.endsWith('_inner')) paint['line-color'] = p.road;
  else if (id.endsWith('_subtle')) paint['line-color'] = p.roadCasing;
  else if (id.startsWith('railway')) paint['line-color'] = p.rail;
  else if (id.startsWith('highway-name')) {
    paint['text-color'] = p.label;
    paint['text-halo-color'] = p.labelHalo;
    paint['text-halo-width'] = 1;
    paint['text-halo-blur'] = 0;
    layout['text-field'] = KOREAN_NAME;
    layout['text-size'] = 10;
    layout['text-padding'] = 8;
  }
  return { ...layer, paint, layout };
}

function recolor(style: StyleJson, p: MapCanvasPalette): StyleJson {
  return { ...style, layers: style.layers.filter((l) => KEEP.has(l.id)).map((l) => paintFor(l, p)) };
}

/**
 * 안드로이드 배포 빌드의 웹뷰는 file:// 에서 열려 모듈 blob 작업자가 막힌다.
 * 대신 일반(classic) 작업자로 띄워 CDN 모듈을 동적 import 하고, 그사이 온 메시지는 모았다가 다시 보낸다.
 * 끝의 '//.cjs' 는 maplibre 가 이 주소를 일반 작업자로 띄우게 하는 표시다.
 */
function fileOriginWorker(cdn: string): string {
  const boot =
    'var q=[];function h(e){q.push(e)}self.addEventListener("message",h);' +
    `import(${JSON.stringify(cdn)}).then(function(){self.removeEventListener("message",h);` +
    'q.forEach(function(e){self.dispatchEvent(new MessageEvent("message",{data:e.data}))})});';
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(boot)}//.cjs`;
}

/** 작업자(worker)는 설치된 maplibre-gl 과 같은 판을 CDN 에서 — 번들러가 import.meta.url 로 worker 를 찾지 못한다 */
let workerSet = false;
function ensureWorker() {
  if (workerSet) return;
  workerSet = true;
  // maplibre 의 import.meta.url 은 번들에서 globalThis.__ExpoImportMetaRegistry.url 로 바뀐다.
  // 앱 번들(웹)은 expo 가 채우지만 안드로이드 웹뷰의 DOM 번들에는 없어서 여기서 채운다.
  const g = globalThis as { __ExpoImportMetaRegistry?: { url: string } };
  if (!g.__ExpoImportMetaRegistry) g.__ExpoImportMetaRegistry = { url: typeof location !== 'undefined' ? location.href : 'about:blank' };
  const cdn = `https://cdn.jsdelivr.net/npm/maplibre-gl@${getVersion()}/dist/maplibre-gl-worker.mjs`;
  const fileOrigin = typeof location !== 'undefined' && location.protocol === 'file:';
  setWorkerUrl(fileOrigin ? fileOriginWorker(cdn) : cdn);
}

const LOAD_TIMEOUT_MS = 12_000;

export default function MapCanvas({ lat, lng, zoom, styleUrl, palette, onStatus }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const report = useRef(onStatus);
  useEffect(() => {
    report.current = onStatus;
  }, [onStatus]);
  const initial = useRef({ lat, lng, zoom, styleUrl, palette });

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let cancelled = false;
    let settled = false;
    const settle = (status: MapCanvasStatus, detail?: string) => {
      if (settled || cancelled) return;
      settled = true;
      void Promise.resolve(report.current?.(status, detail)).catch(() => {});
    };
    const timer = setTimeout(() => settle('error', 'timeout'), LOAD_TIMEOUT_MS);
    const { lat: lat0, lng: lng0, zoom: zoom0, styleUrl: url, palette: p } = initial.current;

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`style ${res.status}`);
        const style = recolor((await res.json()) as StyleJson, p);
        if (cancelled) return;
        ensureWorker();
        const m = new MapLibreMap({
          container: el,
          style: style as unknown as MapOptions['style'],
          center: [lng0, lat0],
          zoom: zoom0,
          interactive: false,
          attributionControl: false,
          fadeDuration: 0,
          // 한글 라벨은 기기 글꼴로 그린다 — 글리프 파일을 받지 않아도 된다
          localIdeographFontFamily: "Pretendard, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Noto Sans CJK KR', sans-serif",
        });
        map.current = m;
        m.once('load', () => {
          clearTimeout(timer);
          settle('ready');
        });
        m.on('error', (e) => {
          // 타일 몇 장 실패는 넘어가고, 스타일을 못 그리면 실패로 본다
          if (!m.loaded()) settle('error', String(e.error?.message ?? 'map error'));
        });
      } catch (err) {
        clearTimeout(timer);
        settle('error', err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // 위치가 바뀌면 가운데를 옮긴다 (부드럽게, 줄임 모션이면 바로)
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) m.jumpTo({ center: [lng, lat], zoom });
    else m.easeTo({ center: [lng, lat], zoom, duration: 600 });
  }, [lat, lng, zoom]);

  return (
    <div
      ref={holder}
      aria-hidden
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden', background: palette.block }}
    />
  );
}
