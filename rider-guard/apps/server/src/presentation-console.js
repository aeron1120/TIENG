/* Public, isolated presentation monitor. Capability tokens remain in the URL fragment or memory. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const statusNames = { confirming: '라이더에게 확인하고 있어요', rider_ok: '본인 확인 후 감시로 돌아왔어요', escalated: '관제 대응이 시작됐어요', acknowledged: '연락과 주문 인계를 진행해요', resolved: '대응을 마치고 기록을 남겼어요' };
  const orderNames = { delivering: '배달 중', held: '일시 보류', reassigned: '대체 배차 완료', delivered: '배달 완료' };
  const metricNames = { peak_g: '가속도', peak_gyro: '각속도', delta_v150: 'ΔV · 150ms', bank_deg: '뱅크각' };
  const params = new URLSearchParams(location.hash.slice(1));
  let sessionId = params.get('session');
  let readToken = params.get('key');
  let writeToken = null;
  let session = null;
  let cases = [];
  let queue = [];
  let pending = null;
  let sending = false;
  let polling = false;
  let transportFailed = false;
  let permanentFailure = false;
  let errorText = '';
  let lastPollAt = 0;
  let renderedEvidence = null;
  let renderedLog = '';
  let renderedOrders = '';
  let creating = false;
  let lastTickAt = performance.now();
  const driver = `monitor-${Math.random().toString(36).slice(2)}`;

  function node(tag, value, className) {
    const item = document.createElement(tag);
    if (value !== undefined) item.textContent = value;
    if (className) item.className = className;
    return item;
  }

  function number(value, decimals = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: decimals }) : '값 없음';
  }

  function wall(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' });
  }

  function setError(message = '') {
    errorText = message;
    $('error').textContent = message;
    $('error').hidden = !message;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal, cache: 'no-store', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const error = new Error(data?.error?.message ?? `요청을 처리하지 못했어요 (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      if (!data) throw new Error('서버 응답을 읽지 못했어요. 연결을 확인하세요.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('서버 응답이 지연되고 있어요. 마지막 명령을 보관하고 다시 연결합니다.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function receive(data) {
    if (data.id !== sessionId) return;
    if (session && data.id === session.id && data.lastSequence < session.lastSequence) return;
    session = data;
    lastPollAt = Date.now();
    $('setup').hidden = true;
    $('session-view').hidden = false;
    document.querySelector('.intro').hidden = true;
    $('session-view').style.paddingTop = '32px';
    $('controls').hidden = !writeToken;
    $('readonly-note').hidden = !!writeToken;
    render();
  }

  async function loadCases() {
    try {
      const data = await request('/demo-api/results');
      cases = data.items;
      const select = $('case-select');
      select.replaceChildren(...cases.map((item) => {
        const option = node('option', `${item.id} · ${item.name} · ${item.v1.decision === 'candidate' ? '후보 감지' : item.v1.decision === 'insufficient' ? '판정 제한' : '후보 없음'}`);
        option.value = item.id;
        return option;
      }));
      select.disabled = false;
      $('start-measured').disabled = false;
      updateCaseNote();
    } catch {
      $('case-note').textContent = '실측 목록을 불러오지 못했어요. 서버 연결을 확인하고 페이지를 새로고침하세요.';
      $('case-select').replaceChildren(node('option', '실측 목록을 불러올 수 없음'));
    }
  }

  function updateCaseNote() {
    const item = cases.find((c) => c.id === $('case-select').value);
    if (item) $('case-note').textContent = `원본 1회차 파형 · ${item.repeats.n}회 중 후보 ${item.repeats.candidates}회 · 기록 판정과 ${item.v1.match ? '일치' : '불일치'} (실제 사고 정답 검증과 별개)`;
  }

  async function createSession(body) {
    if (creating) return;
    creating = true;
    setError();
    for (const button of $('setup').querySelectorAll('button')) button.disabled = true;
    try {
      const data = await request('/demo-api/presentations', { method: 'POST', body: JSON.stringify(body) });
      sessionId = data.id;
      readToken = data.readToken;
      writeToken = data.writeToken;
      queue = [];
      pending = null;
      permanentFailure = false;
      transportFailed = false;
      // Reloads and shared links intentionally open as read-only viewers.
      history.replaceState(null, '', `/ops/presentation#${new URLSearchParams({ session: sessionId, key: readToken })}`);
      receive(data);
      enqueue({ type: 'autopilot', on: true }, { type: 'play', driver });
    } catch (error) { setError(`발표를 시작하지 못했어요. ${error.message}`); }
    finally {
      creating = false;
      for (const button of $('setup').querySelectorAll('button')) button.disabled = false;
      $('start-measured').disabled = !cases.length;
    }
  }

  function enqueue(...actions) {
    if (!writeToken || permanentFailure) return;
    queue.push(...actions);
    void flush();
  }

  async function flush() {
    if (sending || permanentFailure || !writeToken || !session || (!pending && !queue.length)) return;
    sending = true;
    if (!pending) {
      const actions = queue.splice(0, 100);
      pending = { commands: actions.map((action, index) => ({ seq: session.lastSequence + index + 1, action })) };
    }
    try {
      const data = await request(`/demo-api/presentations/${encodeURIComponent(sessionId)}/commands`, { method: 'POST', headers: { Authorization: `Bearer ${writeToken}` }, body: JSON.stringify(pending) });
      const expected = pending.commands.at(-1).seq;
      if (data.lastSequence < expected) throw new Error('서버에서 마지막 명령의 수신을 확인하지 못했어요.');
      pending = null;
      transportFailed = false;
      setError();
      receive(data);
    } catch (error) {
      transportFailed = true;
      // A transient failure freezes the clock and retains the EXACT same batch for retry.
      permanentFailure = [400, 401, 403, 404, 409, 410, 413, 422].includes(error.status);
      setError(permanentFailure ? `진행을 중지했어요. ${error.message} 현재 기록을 저장하거나 새 발표를 시작하세요.` : `연결이 끊겨 시연 시계를 멈췄어요. ${error.message} 같은 순번의 명령으로 자동 재시도합니다.`);
      updateConnection();
    } finally {
      sending = false;
      if (!transportFailed && queue.length) void flush();
    }
  }

  async function poll() {
    if (polling || !sessionId || !readToken || permanentFailure) return;
    polling = true;
    try {
      const data = await request(`/demo-api/presentations/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${readToken}` } });
      if (!pending) { transportFailed = false; setError(); }
      receive(data);
    } catch (error) {
      transportFailed = true;
      permanentFailure = [401, 403, 404, 410].includes(error.status);
      setError(permanentFailure ? `세션을 열 수 없어요. ${error.message} 새 발표를 시작하거나 유효한 읽기 링크를 사용하세요.` : `서버 수신을 확인할 수 없어요. ${error.message} 자동으로 다시 연결합니다.`);
      updateConnection();
    } finally { polling = false; }
  }

  function updateConnection() {
    if (!session) return;
    const state = session.state;
    const age = Math.max(0, (Date.now() - new Date(session.receivedAt).getTime()) / 1000);
    const stale = state.playing && age > 5;
    const sensorLost = state.sensorLost;
    const missed = missedCandidate(state);
    const unavailable = transportFailed || Date.now() - lastPollAt > 10000;
    let label = '시연 일시 정지';
    let style = 'badge neutral';
    if (unavailable) { label = '연결 확인 필요'; style = 'badge warning'; }
    else if (stale) { label = '진행 데이터 지연'; style = 'badge warning'; }
    else if (sensorLost) { label = '센서 신호 중단 · 시연'; style = 'badge warning'; }
    else if (missed) { label = '판정 구간 누락 · 기록 보존'; style = 'badge warning'; }
    else if (state.incident?.status === 'resolved' || (!state.playing && state.clipDone)) { label = '발표 기록 수신 완료'; }
    else if (state.playing) { label = '진행 명령 수신 중'; style = 'badge'; }
    else if (state.t === 0) { label = '서버 수신 · 시작 대기'; }
    $('connection').textContent = label;
    $('connection').className = style;
    $('receipt-time').textContent = `마지막 명령 수신 ${wall(session.receivedAt)} KST · ${Math.floor(age)}초 전`;
    $('transport-note').textContent = unavailable ? '마지막으로 확인한 상태를 표시합니다. 새 명령 수신 전까지 진행을 확정하지 않습니다.' : stale ? '서버는 응답하지만 시연 출처의 진행 명령이 5초 이상 오지 않았어요. 연결한 시연 탭의 실행 상태를 확인하세요.' : sensorLost ? '시연에서 센서 신호가 중단되었습니다. 서버 연결 상태와 센서 수신 상태는 별개입니다.' : writeToken ? '발표 자동 진행은 본인 확인 대기를 거친 뒤 연락·대체 배차·보고서로 이어집니다. 연결이 끊기면 시계를 멈추고 수신부터 다시 확인합니다.' : '이 화면은 서버가 수신한 상태만 표시합니다. 원본 시연 화면을 닫으면 진행 데이터가 멈춥니다.';
    if (permanentFailure) $('transport-note').textContent = errorText;
    for (const button of $('controls').querySelectorAll('button')) button.disabled = permanentFailure;
    $('play').disabled = permanentFailure || state.playing || !!pending;
    $('pause').disabled = permanentFailure || !state.playing;
    $('autopilot').disabled = permanentFailure;
    $('slowmo').disabled = permanentFailure;
  }

  function missedCandidate(state) {
    return !state.incident && state.clipDone && session.clip.candidateAt !== null;
  }

  function assessmentLimited(state) {
    return !state.incident && state.clipDone && session.analysis?.decision === 'insufficient';
  }

  function render() {
    const s = session.state;
    const incident = s.incident;
    const missed = missedCandidate(s);
    const limited = assessmentLimited(s);
    $('source-kind').textContent = session.source.kind === 'import' ? 'IMPORTED REPLAY / 제공된 판정 기록' : session.source.kind === 'integrated' ? 'CONNECTED DEMO / 통합 시연 연결' : 'MEASURED EXPERIMENT / 실측 기록 재생';
    const caseInfo = cases.find((item) => item.id === session.source.caseId);
    $('source-label').textContent = caseInfo ? `${caseInfo.id} · ${caseInfo.name}` : session.source.label;
    $('source-note').textContent = session.source.note;
    $('session-id').textContent = `격리 세션 ${session.id.slice(0, 12)} · 수신 #${session.lastSequence}`;
    $('demo-clock').textContent = `${wall(s.baseWall + s.t * 1000)} KST · +${s.t.toFixed(1)}s`;
    $('event-title').textContent = incident ? statusNames[incident.status] ?? incident.status : missed ? '수신 누락으로 판정하지 못했어요' : s.sensorLost ? '센서 연결을 확인하고 있어요' : limited ? '자료가 부족해 판정이 제한됐어요' : s.clipDone ? '사고 후보 없이 분석을 마쳤어요' : s.t >= 6 ? '사건 구간을 분석하고 있어요' : '라이더의 주행을 지켜보고 있어요';
    const wait = incident?.status === 'confirming' ? Math.max(0, Math.ceil(30 - (s.t - incident.detectedT))) : null;
    $('event-description').textContent = wait !== null ? `확인 요청 후 ${wait}초 남음 · “괜찮아요” 또는 “도움이 필요해요”로 본인이 응답할 수 있어요.` : incident?.status === 'resolved' ? `${incident.id} · 사건 경과와 주문 인계가 같은 시계에 기록되었습니다.` : incident?.status === 'rider_ok' ? '라이더의 응답을 기록했습니다. 이 응답만으로 실제 사고 여부를 확정하지 않습니다.' : incident ? '비상연락처와 관제에 상황을 공유하고, 진행 중인 주문을 안전하게 인계합니다. 모든 과정은 시연입니다.' : missed ? '원본에는 후보 시점이 있지만, 시연 센서가 끊긴 동안 해당 구간을 받아 판정하지 못했습니다. 이후 재연결되어도 정상으로 바꾸지 않습니다.' : limited ? '누락된 자료 때문에 후보 여부를 충분히 판단할 수 없습니다. 판정 제한과 근거를 그대로 기록합니다.' : s.clipDone ? session.detection ? '외부에서 제공한 후보 판정이 false인 기록입니다. 실제 사고 여부를 확정하지 않으며 사고 대응으로 강제 진행하지 않습니다.' : '후보 조건을 충족하지 않은 기록입니다. 사고 대응이나 대체 배차로 강제 진행하지 않습니다.' : '서버가 받은 실측·재생 자료에 따라 동일한 시연 시계를 진행합니다.';
    $('response-value').textContent = wait !== null ? `${wait}초 남음` : ({ ok: '괜찮아요', help: '도움 요청', timeout: '30초 무응답' }[incident?.response] ?? '대기 전');
    $('assignee-value').textContent = incident?.assignee ?? '아직 배정 전';
    $('reassigned-value').textContent = `${s.orders.filter((order) => order.status === 'reassigned').length}건`;
    $('response-controls').hidden = !writeToken || wait === null;
    $('manual-controls').hidden = !writeToken || !incident || !['escalated', 'acknowledged'].includes(incident.status);
    $('ack').disabled = incident?.status !== 'escalated' || permanentFailure;
    for (const button of $('response-controls').querySelectorAll('button')) button.disabled = permanentFailure;
    for (const id of ['call', 'reassign', 'resolve']) $(id).disabled = permanentFailure;
    $('autopilot').checked = !!s.autoPilot;
    $('slowmo').checked = s.slowmo;
    $('play').textContent = s.t > 0 ? '발표 이어가기' : '자동 발표 시작';
    renderPipeline(s);
    const evidenceKey = JSON.stringify([session.id, session.source, session.clip, session.analysis?.ruleVersion, session.analysis?.decision, session.analysis?.candidateAt, session.detection?.detection_id]);
    if (renderedEvidence !== evidenceKey) { renderEvidence(); renderedEvidence = evidenceKey; }
    renderOrders(s);
    renderTimeline(s);
    $('report-summary').textContent = `${session.source.label} · ${incident ? statusNames[incident.status] ?? incident.status : missed ? '센서 수신 누락 / 판정하지 못함' : limited ? '자료 부족 / 판정 제한' : s.clipDone ? '후보 없음 / 분석 종료' : '분석 진행 중'} · 주문 인계 ${s.orders.filter((order) => order.status === 'reassigned').length}건 · 기록 ${s.log.length}건`;
    $('report-validity').textContent = `서버 수신 ${new Date(session.receivedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST / 시연 +${number(s.t, 1)}초. 후보 판정은 실제 사고의 확정이 아닙니다. ${session.source.kind === 'import' ? '외부에서 제공한 판정이며 원본 파형을 재검증하지 않았습니다.' : '실측 신호를 재분석했으며 라이더·연락·주문 흐름은 시연입니다.'}`;
    updateConnection();
  }

  function renderPipeline(s) {
    const i = s.incident;
    const labels = ['자료 수신', '후보 판정', '본인 확인', '관제 대응', '주문 인계', '기록 완료'];
    const missed = missedCandidate(s);
    const limited = assessmentLimited(s);
    const normalDone = !i && s.clipDone && !missed && !limited;
    const riderDone = i?.status === 'rider_ok';
    const done = [true, !!i || (s.clipDone && !missed && !limited), !!i && i.status !== 'confirming', !!i?.ackT || i?.status === 'resolved', s.orders.some((o) => o.status === 'reassigned'), i?.status === 'resolved' || normalDone || riderDone];
    if (missed || limited) { labels[1] = '판정 제한'; labels[2] = '확인 미진행'; labels[3] = '대응 미진행'; labels[4] = '주문 유지'; labels[5] = '제한 기록'; }
    if (normalDone) { labels[2] = '확인 불필요'; labels[3] = '대응 없음'; labels[4] = '배달 유지'; }
    if (riderDone) { labels[3] = '감시 복귀'; labels[4] = '배달 유지'; }
    const current = done.findIndex((item) => !item);
    $('pipeline').replaceChildren(...labels.map((label, index) => {
      const li = node('li', undefined, done[index] ? 'done' : index === current && !normalDone && !riderDone ? 'current' : '');
      if (li.className === 'current') li.setAttribute('aria-current', 'step');
      li.append(node('span', `0${index + 1}`), node('strong', label));
      return li;
    }));
  }

  function addDetail(label, value) {
    $('source-details').append(node('dt', label), node('dd', value ?? '기록 없음'));
  }

  function renderEvidence() {
    const analysis = session.analysis;
    const detection = session.detection;
    const decision = analysis?.decision ?? (detection?.result.candidate ? 'candidate' : 'no_candidate');
    $('decision').textContent = `${detection ? '제공된 판정 · ' : ''}${{ candidate: '후보 감지', no_candidate: '후보 없음', insufficient: '판정 제한' }[decision]}`;
    $('decision').className = `badge ${decision === 'candidate' || decision === 'insufficient' ? 'warning' : 'neutral'}`;
    $('rule-description').textContent = analysis ? `${analysis.ruleVersion} · ${number(analysis.windowS)}초 판정창 · 가속도 필수 조건과 보조 조건 중 하나를 함께 확인합니다. 아래 관측값은 기록 전체 최대값이며 발동 여부는 판정창 기준입니다.` : `${detection?.detector.name ?? ''} ${detection?.detector.version ?? ''} · 제공된 규칙: ${detection?.detector.rule.expression ?? '기록 없음'}. 표의 발동 여부는 입력 판정값이며 서버 재분석 결과가 아닙니다.`;
    const evidence = analysis ? analysis.evidence.map((item) => ({ label: metricNames[item.key] ?? item.key, value: item.peak, unit: item.unit, threshold: item.threshold, fired: item.passedAt !== null, basis: '전체 최대', op: item.key === 'bank_deg' ? '|값| ≥' : '≥' })) : (detection?.evidence ?? []).map((item) => ({ ...item, basis: item.value_basis === 'run_peak' ? '전체 최대' : '관찰창', op: item.op === 'abs>=' ? '|값| ≥' : '≥' }));
    $('evidence-body').replaceChildren(...evidence.map((item) => {
      const tr = node('tr');
      const label = node('td');
      label.append(node('span', item.label), node('div', item.basis, 'fine'));
      tr.append(label, node('td', `${number(item.value)}${item.value == null ? '' : ` ${item.unit}`}`), node('td', `${item.op} ${number(item.threshold)} ${item.unit}`), node('td', item.fired === null ? '값 없음' : item.fired ? '발동' : '미발동', item.fired ? 'evidence-pass' : 'evidence-miss'));
      return tr;
    }));
    $('quality').textContent = analysis ? `순번 누락 ${analysis.quality.missingPackets}개 · 포화 표본 ${analysis.quality.saturation.length}개 · ΔV ${analysis.quality.dvValid ? '계산 가능' : '계산 제한'}${analysis.quality.dvInvalidReasons.length ? ` (${analysis.quality.dvInvalidReasons.join(', ')})` : ''} · ${analysis.metadata.sampleRateHz ?? '미상'} Hz` : `외부 검증 상태: ${detection?.detector.status ?? '기록 없음'} · 프로필: ${detection?.detector.profile ?? '기록 없음'} · 후보 시각 ${number(detection?.result.t_candidate_s, 3)}초`;
    renderWaveform(analysis?.waveform ?? []);
    $('source-details').replaceChildren();
    addDetail('출처', session.source.label);
    addDetail('설명', session.source.note);
    if (analysis) {
      addDetail('규칙', analysis.ruleVersion);
      addDetail('판정 시각', analysis.candidateAt === null ? '후보 없음' : `센서 ${number(analysis.candidateAt, 3)}초`);
      addDetail('원본 기록', analysis.metadata.provenance);
      addDetail('측정일·보드', '기록 없음');
      const info = cases.find((item) => item.id === session.source.caseId);
      if (info) {
        addDetail('조건 분류', info.class);
        addDetail('반복 실험', `${info.repeats.n}회 중 후보 ${info.repeats.candidates}회`);
        addDetail('기록 재현', info.v1.match ? '원본 기록의 후보 판정과 일치 (사고 정답 검증과 별개)' : '원본 기록의 후보 판정과 불일치');
      }
    } else if (detection) {
      addDetail('검출 ID', detection.detection_id);
      addDetail('발생 기록', detection.occurred_at);
      addDetail('재생 조건', `${detection.source.replay?.scenario_id ?? ''} · ${detection.source.replay?.scenario_name ?? ''}`);
      addDetail('실험 실행', detection.source.replay?.run_id);
      addDetail('제공된 분류', detection.source.replay?.ground_truth);
      addDetail('근거의 한계', '후보와 분류는 가져온 JSON의 주장입니다. 원본 파형·실제 사고 여부는 여기서 검증하지 않았습니다.');
    }
  }

  function renderWaveform(samples) {
    $('waveform-wrap').hidden = samples.length < 2;
    $('no-waveform').hidden = samples.length >= 2;
    const svg = $('waveform');
    svg.replaceChildren();
    if (samples.length < 2) return;
    const min = samples[0].t;
    const max = samples.at(-1).t;
    const peak = Math.max(7, ...samples.map((item) => item.accG ?? 0));
    const y = (value) => 105 - value / peak * 95;
    function shape(tag, attributes) {
      const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
      svg.append(item);
      return item;
    }
    shape('line', { x1: 0, y1: 105, x2: 600, y2: 105, stroke: '#d8ded4' });
    shape('line', { x1: 0, y1: y(6), x2: 600, y2: y(6), stroke: '#c78459', 'stroke-dasharray': '4 5' });
    const threshold = shape('text', { x: 5, y: y(6) - 5, fill: '#996b4e', 'font-size': 9 });
    threshold.textContent = '6g';
    let path = '';
    let connected = false;
    for (let index = 0; index < samples.length; index++) {
      const item = samples[index];
      if (item.accG === null || item.gap || (index && item.t - samples[index - 1].t > .02)) { connected = false; if (item.accG === null || item.gap) continue; }
      const x = (item.t - min) / Math.max(.001, max - min) * 600;
      path += `${connected ? 'L' : 'M'}${x.toFixed(2)},${y(item.accG).toFixed(2)} `;
      connected = true;
    }
    shape('path', { d: path, fill: 'none', stroke: '#1e5144', 'stroke-width': 1.7, 'vector-effect': 'non-scaling-stroke' });
    $('waveform-range').textContent = `${number(min, 3)}–${number(max, 3)}s · 0–${number(peak, 1)}g`;
    $('waveform-note').textContent = '점선: 가속도 6g 기준 · 누락 구간은 연결하지 않습니다. 가속도만으로 사고 후보를 결정하지 않습니다.';
  }

  function renderOrders(s) {
    const signature = JSON.stringify(s.orders);
    if (renderedOrders === signature) return;
    renderedOrders = signature;
    const relevant = s.orders.filter((order) => order.originalRiderId === 'r1');
    $('orders').replaceChildren(...relevant.map((order) => {
      const item = node('article', undefined, 'order');
      const heading = node('div', undefined, 'order-heading');
      heading.append(node('h3', `${order.id} · ${order.store}`), node('span', orderNames[order.status] ?? order.status, `badge ${order.status === 'held' ? 'warning' : 'neutral'}`));
      const rider = s.riders.find((r) => r.id === order.riderId);
      item.append(heading, node('p', `${rider?.name ?? order.riderId} → ${order.customer}`, 'subtle'));
      if (order.notices.length) {
        const list = node('ul', undefined, 'order-notices');
        for (const notice of order.notices) list.append(node('li', `${notice.to} · ${notice.text} (시연)`));
        item.append(list);
      } else item.append(node('p', '안내 기록 없음 · 배달 진행 중', 'fine'));
      return item;
    }));
  }

  function renderTimeline(s) {
    const signature = `${s.baseWall}:${s.log.length}:${s.log.at(-1)?.text}`;
    if (renderedLog === signature) return;
    renderedLog = signature;
    $('timeline').replaceChildren(...s.log.map((entry) => {
      const li = node('li');
      const time = node('time', `+${number(entry.t, 1)}s`);
      time.title = `${wall(s.baseWall + entry.t * 1000)} KST`;
      li.append(time, node('p', entry.text));
      return li;
    }));
    $('log-count').textContent = `${s.log.length}개 기록`;
  }

  $('measured-form').addEventListener('submit', (event) => { event.preventDefault(); void createSession({ caseId: $('case-select').value }); });
  $('case-select').addEventListener('change', updateCaseNote);
  $('import-form').addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const raw = $('json-input').value.trim();
      if (new Blob([raw]).size > 60000) throw new Error('JSON 파일은 60KB 이하로 선택하세요.');
      const detection = JSON.parse(raw);
      if (detection?.schema_version !== '1.0' || detection?.source?.mode !== 'replay') throw new Error('schema_version이 1.0이고 source.mode가 replay인 detection.v1 자료를 사용하세요.');
      void createSession({ detection });
    } catch (error) { setError(`JSON을 확인해주세요. ${error.message}`); }
  });
  $('json-file').addEventListener('change', async () => {
    const file = $('json-file').files?.[0];
    if (!file) return;
    if (file.size > 60000) { setError('JSON 파일은 60KB 이하로 선택하세요.'); return; }
    try { $('json-input').value = await file.text(); setError(); }
    catch { setError('파일을 읽을 수 없어요. JSON을 직접 붙여넣거나 다시 선택하세요.'); }
  });
  $('play').addEventListener('click', () => enqueue({ type: 'autopilot', on: $('autopilot').checked }, { type: 'play', driver }));
  $('pause').addEventListener('click', () => enqueue({ type: 'pause' }));
  $('reset').addEventListener('click', () => enqueue({ type: 'reset', baseWall: Date.now() }, { type: 'autopilot', on: $('autopilot').checked }));
  $('autopilot').addEventListener('change', () => enqueue({ type: 'autopilot', on: $('autopilot').checked }));
  $('slowmo').addEventListener('change', () => enqueue({ type: 'slowmo', on: $('slowmo').checked }));
  $('respond-ok').addEventListener('click', () => enqueue({ type: 'respond', response: 'ok' }));
  $('respond-help').addEventListener('click', () => enqueue({ type: 'respond', response: 'help' }));
  $('skip-wait').addEventListener('click', () => enqueue({ type: 'skipWait' }));
  $('ack').addEventListener('click', () => enqueue({ type: 'ack' }));
  $('call').addEventListener('click', () => enqueue({ type: 'call' }));
  $('resolve').addEventListener('click', () => enqueue({ type: 'resolve' }));
  $('reassign').addEventListener('click', () => {
    if (!session) return;
    const candidates = session.state.riders.filter((rider) => rider.id !== 'r1' && rider.base !== 'off').sort((a, b) => session.state.orders.filter((o) => o.riderId === a.id && o.status !== 'delivered').length - session.state.orders.filter((o) => o.riderId === b.id && o.status !== 'delivered').length);
    if (candidates.length) enqueue(...session.state.orders.filter((order) => order.status === 'held').map((order, index) => ({ type: 'reassign', orderId: order.id, riderId: candidates[index % candidates.length].id })));
  });
  $('print').addEventListener('click', () => window.print());
  $('download').addEventListener('click', () => {
    if (!session) return;
    // Explicit fields exclude read/write capabilities from exported reports.
    const { id, source, state, clip, analysis, detection, lastSequence, receivedAt, expiresAt } = session;
    const report = { reportType: 'rider-guard.presentation.v1', exportedAt: new Date().toISOString(), isolatedDemo: true, id, source, state, clip, analysis, detection, lastSequence, receivedAt, expiresAt };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = `rider-guard-${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/ops/presentation#${new URLSearchParams({ session: sessionId, key: readToken })}`);
      $('share').textContent = '읽기 링크 복사됨';
      setTimeout(() => { $('share').textContent = '읽기 링크 복사'; }, 2000);
    } catch { setError('링크를 복사하지 못했어요. 주소창의 주소를 복사하면 읽기 전용 링크를 공유할 수 있어요.'); }
  });

  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(.5, (now - lastTickAt) / 1000);
    lastTickAt = now;
    // Never catch up lost wall time, queue ticks behind a slow request, or skip unacknowledged commands.
    if (writeToken && session?.state.playing && !transportFailed && !permanentFailure && !sending && !pending && !queue.length) enqueue({ type: 'tick', dt });
  }, 200);
  setInterval(() => { if (pending && transportFailed && !permanentFailure) void flush(); else void poll(); updateConnection(); }, 2000);
  setInterval(updateConnection, 1000);
  if (sessionId && readToken) { void poll(); void loadCases().then(() => { if (session) { renderedEvidence = null; render(); } }); }
  else { if (sessionId || readToken) setError('읽기 링크가 불완전해요. session과 key가 포함된 링크로 열거나 새 발표를 시작하세요.'); void loadCases(); }
})();
