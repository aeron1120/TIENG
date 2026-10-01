// 말로 응답하기 — 사고 확인 화면에서 질문을 소리로 읽고, 라이더의 말('괜찮아요' / '도와주세요')을 알아듣는다.
// 헬멧 스피커·마이크 연동은 아직 없어 휴대폰·브라우저의 스피커와 마이크를 쓴다.
// 웹은 브라우저 음성 인식(Web Speech API — Chrome·Edge·Safari·안드로이드 Chrome)이 있을 때만. 네이티브 앱은 아직 지원하지 않는다.
// 못 알아들으면 아무것도 보내지 않는다 — 무응답은 서버 카운트다운이 그대로 처리하고, 화면 버튼은 늘 함께 쓸 수 있다.
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { interpretSpeech } from '@/lib/speech';

/** 켜고 끌 때 알리는 토스트 (components/Toast 의 useToast) */
type Toaster = { success: (m: string) => void; error: (m: string) => void };

/** 말로 응답하기 줄 아래 설명 — 지원하지 않는 브라우저·앱이면 그렇게 알린다 */
export const voiceSub = (on: boolean) =>
  !voiceSupported()
    ? Platform.OS === 'web'
      ? '이 브라우저는 음성 인식을 지원하지 않아요 (Chrome·Edge·Safari에서 돼요)'
      : '앱에서는 아직 지원하지 않아요. 화면 버튼으로 응답해요'
    : on
      ? '사고 때 질문을 읽어 주고, “괜찮아요”·“도와주세요”를 알아들어요'
      : '사고 때 휴대폰 스피커로 묻고 말로 답해요';

/** 켤 때 마이크 권한을 먼저 받는다 — 사고 순간에 권한 창이 뜨지 않게 */
export async function toggleVoice(on: boolean, set: (v: boolean) => void, toast: Toaster) {
  if (!on) return set(false);
  if (await requestMicrophone()) {
    set(true);
    toast.success('말로 응답하기를 켰어요');
  } else toast.error('마이크 권한이 필요해요. 브라우저 주소창의 권한 설정에서 마이크를 허용해 주세요');
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 이 기기·브라우저에서 말로 응답할 수 있는가 */
export const voiceSupported = () => recognitionCtor() != null;

/** 켤 때 마이크 권한을 미리 받는다 — 사고 순간에 권한 창이 뜨지 않게. 허용되면 true */
export async function requestMicrophone(): Promise<boolean> {
  if (!voiceSupported()) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export type VoiceState = 'off' | 'speaking' | 'listening' | 'unsupported' | 'blocked';

const PROMPT = '사고가 의심돼요. 괜찮으시면 괜찮아요, 도움이 필요하면 도와주세요 라고 말해 주세요.';

/**
 * 사고 확인 화면에서 켠다. 질문을 읽은 뒤 듣기 시작하고, 알아들은 응답을 한 번만 onAnswer 로 보낸다.
 * 브라우저가 침묵 끝에 듣기를 멈추면 enabled 인 동안 다시 듣는다.
 */
export function useVoiceAnswer(enabled: boolean, onAnswer: (answer: 'ok' | 'help') => void): { state: VoiceState; heard: string } {
  const supported = voiceSupported();
  // 효과 안에서 바로 상태를 바꾸지 않는다 — 처음엔 '읽는 중', 듣기 시작·권한 거부는 콜백에서 바꾼다
  const [state, setState] = useState<'speaking' | 'listening' | 'blocked'>('speaking');
  const [heard, setHeard] = useState('');
  const answer = useRef(onAnswer);
  useEffect(() => {
    answer.current = onAnswer;
  }, [onAnswer]);

  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!enabled || !Ctor) return;
    let alive = true;
    let done = false;
    let rec: Recognition | null = null;

    const listen = () => {
      if (!alive || done) return;
      rec = new Ctor();
      rec.lang = 'ko-KR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
        setHeard(text);
        const a = interpretSpeech(text);
        if (a && !done) {
          done = true;
          rec?.abort();
          answer.current(a);
        }
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          done = true;
          setState('blocked');
        }
      };
      // 침묵이 길면 브라우저가 멈춘다 — 응답 전이면 다시 듣는다
      rec.onend = () => {
        if (alive && !done) setTimeout(listen, 250);
      };
      try {
        rec.start();
        setState('listening');
      } catch {
        setTimeout(listen, 500);
      }
    };

    // 질문을 먼저 읽는다. 읽기가 안 되면 바로 듣는다.
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (synth && typeof SpeechSynthesisUtterance !== 'undefined') {
      const u = new SpeechSynthesisUtterance(PROMPT);
      u.lang = 'ko-KR';
      u.rate = 1.05;
      u.onend = listen;
      u.onerror = listen;
      synth.cancel();
      synth.speak(u);
      // 일부 브라우저는 onend 를 부르지 않는다 — 늦어도 7초 뒤에는 듣는다
      const fallback = setTimeout(() => {
        if (!rec) listen();
      }, 7000);
      return () => {
        alive = false;
        clearTimeout(fallback);
        synth.cancel();
        rec?.abort();
      };
    }
    const start = setTimeout(listen, 0);
    return () => {
      alive = false;
      clearTimeout(start);
      rec?.abort();
    };
  }, [enabled]);

  return { state: !enabled ? 'off' : !supported ? 'unsupported' : state, heard };
}
