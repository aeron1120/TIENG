// 말로 응답하기에서 들은 말을 응답으로 바꾼다 (features/voice). 순수 함수라 테스트한다.

const HELP = /(도와|도움|살려|아파|아퍼|구급|119|신고|다쳤)/;
const OK = /(괜찮|괜찬|괜잖|이상\s*없|문제\s*없|멀쩡)/;

/** 들은 말 → 응답. 도움 요청을 먼저 본다('안 괜찮아, 도와줘'). 둘 다 아니면 null */
export function interpretSpeech(text: string): 'help' | 'ok' | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (HELP.test(t) || /안\s*괜찮|안\s*괜찬/.test(t)) return 'help';
  if (OK.test(t)) return 'ok';
  return null;
}
