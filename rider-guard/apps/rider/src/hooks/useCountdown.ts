import { useEffect, useState } from 'react';

/**
 * 마감 시각(기기 시계 기준 epoch ms)까지 남은 초. 매 틱마다 1씩 빼지 않고 마감 시각과의 차이로 계산해서
 * 앱이 백그라운드에 갔다 오거나 JS 스레드가 밀려도 남은 시간이 틀어지지 않는다.
 */
export function useCountdown(deadline: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline == null) return;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() >= deadline) clearInterval(id);
    };
    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline == null) return { left: null, expired: false };
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return { left, expired: left === 0 };
}
