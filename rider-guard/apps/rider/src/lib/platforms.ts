import type { DeliveryPlatform } from '@rider-guard/contract';

/** 주문 플랫폼 — 서버(services/agency.ts PLATFORMS)와 같은 순서 */
export const PLATFORMS: DeliveryPlatform[] = ['baemin', 'coupangeats', 'yogiyo', 'ddangyo', 'other'];
export const PLATFORM_LABEL: Record<DeliveryPlatform, string> = { baemin: '배달의민족', coupangeats: '쿠팡이츠', yogiyo: '요기요', ddangyo: '땡겨요', other: '기타' };
export const PLATFORM_SHORT: Record<DeliveryPlatform, string> = { baemin: '배민', coupangeats: '쿠팡이츠', yogiyo: '요기요', ddangyo: '땡겨요', other: '기타' };

export const platformsText = (ps: DeliveryPlatform[]) => (ps.length ? ps.map((p) => PLATFORM_SHORT[p]).join(' · ') : '플랫폼 미선택');
