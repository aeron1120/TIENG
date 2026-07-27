"""
dashboard/app.py  -  TIENG 로컬 대시보드 (기획서 본선 8.2 / 온디바이스 프라이버시)
==============================================================================
rppg_demo_v4.py 가 --log 로 남기는 측정 CSV(숫자 데이터)만 읽어, BPM/RR/SQI 현재값과
최근 추세 그래프를 로컬 웹으로 보여준다.

프라이버시 원칙 (기획서 3.2 / 5.3 / 12-4)
- 이 서버는 '영상 프레임'에 접근하지 않는다. 오직 숫자 CSV만 읽는다.
- 원본 얼굴 영상은 저장·전송되지 않는다(데모가 프레임을 저장하지 않음).
- 기본 바인딩은 127.0.0.1(로컬)이며 외부로 나가지 않는다.

의존성
    pip install fastapi uvicorn

실행
    # 1) 데모가 CSV를 쓰게 실행
    python rppg_demo_v4.py --log measurements.csv --scenario static
    # 2) 다른 터미널에서 대시보드
    python dashboard/app.py --csv measurements.csv --port 8000
    # 브라우저: http://127.0.0.1:8000

테스트
    python dashboard/app.py --selftest      # TestClient 로 엔드포인트 검증
"""

from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

PRIVACY_STATEMENT = (
    "이 대시보드는 숫자 측정 CSV만 읽습니다. 원본 얼굴 영상은 저장·전송하지 않습니다. "
    "(on-device, numbers-only)"
)

# 그래프/최신값에 쓰는 숫자 열
_NUM_COLS = ["elapsed_sec", "heart_bpm", "heart_sqi", "resp_rpm", "resp_sqi", "fps",
             "peak_snr_db", "roi_jitter_px", "skin_ratio"]


def _tail_lines(path: Path, max_lines: int) -> List[str]:
    """CSV 헤더 + 마지막 max_lines 데이터 라인만 읽는다(대용량 로그 대비)."""
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    if not lines:
        return []
    header = lines[0]
    body = [ln for ln in lines[1:] if ln.strip()]
    return [header] + body[-max_lines:]


def read_rows(path: Path, max_lines: int = 600) -> List[Dict[str, str]]:
    lines = _tail_lines(path, max_lines)
    if not lines:
        return []
    reader = csv.DictReader(io.StringIO("".join(lines)))
    return list(reader)


def _to_float(v: Optional[str]):
    if v is None or v.strip() == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def latest_payload(rows: List[Dict[str, str]]) -> Dict:
    if not rows:
        return {"status": "waiting", "message": "측정 CSV 대기 중...", "privacy": PRIVACY_STATEMENT}
    r = rows[-1]
    return {
        "status": "ok",
        "elapsed_sec": _to_float(r.get("elapsed_sec")),
        "heart_bpm": _to_float(r.get("heart_bpm")),
        "heart_sqi": _to_float(r.get("heart_sqi")),
        "heart_status": r.get("heart_status", ""),
        "heart_hold_reason": r.get("heart_hold_reason", ""),
        "resp_rpm": _to_float(r.get("resp_rpm")),
        "resp_sqi": _to_float(r.get("resp_sqi")),
        "resp_hold_reason": r.get("resp_hold_reason", ""),
        "roi_name": r.get("roi_name", ""),
        "fps": _to_float(r.get("fps")),
        "scenario": r.get("scenario", ""),
        "lowfreq_applied": r.get("lowfreq_applied", ""),
        "privacy": PRIVACY_STATEMENT,
    }


def series_payload(rows: List[Dict[str, str]], n: int) -> Dict:
    rows = rows[-n:]
    out = {"t": [], "heart_bpm": [], "heart_sqi": [], "resp_rpm": []}
    for r in rows:
        out["t"].append(_to_float(r.get("elapsed_sec")))
        out["heart_bpm"].append(_to_float(r.get("heart_bpm")))
        out["heart_sqi"].append(_to_float(r.get("heart_sqi")))
        out["resp_rpm"].append(_to_float(r.get("resp_rpm")))
    return out


def create_app(csv_path: str) -> FastAPI:
    app = FastAPI(title="TIENG TouchFree Vitals Dashboard")
    path = Path(csv_path)

    @app.get("/api/latest")
    def api_latest():
        return JSONResponse(latest_payload(read_rows(path, 5)))

    @app.get("/api/series")
    def api_series(n: int = 120):
        return JSONResponse(series_payload(read_rows(path, max(n, 1)), n))

    @app.get("/api/privacy")
    def api_privacy():
        return JSONResponse({"privacy": PRIVACY_STATEMENT})

    @app.get("/", response_class=HTMLResponse)
    def index():
        return HTMLResponse(INDEX_HTML)

    return app


INDEX_HTML = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>TouchFree Vitals</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e8e8e8}
 header{padding:16px 20px;background:#171a21;border-bottom:1px solid #262a33}
 h1{font-size:18px;margin:0}
 .sub{color:#8a93a2;font-size:12px;margin-top:4px}
 .cards{display:flex;gap:14px;flex-wrap:wrap;padding:20px}
 .card{background:#171a21;border:1px solid #262a33;border-radius:12px;padding:16px 20px;min-width:150px}
 .k{color:#8a93a2;font-size:12px} .v{font-size:30px;font-weight:700;margin-top:6px}
 .u{font-size:13px;color:#8a93a2}
 .badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:12px;margin-top:8px}
 .rel{background:#12351f;color:#5fd48a} .use{background:#35300f;color:#e6c34a} .hold{background:#3a1720;color:#e06a7f}
 .chart{padding:0 20px 24px} canvas{background:#171a21;border:1px solid #262a33;border-radius:12px;padding:10px}
 footer{color:#6b7280;font-size:11px;padding:10px 20px}
</style></head>
<body>
<header>
  <h1>TouchFree Vitals — 로컬 모니터링 대시보드</h1>
  <div class="sub" id="privacy">숫자 데이터만 표시 · 원본 영상 미저장</div>
</header>
<div class="cards">
  <div class="card"><div class="k">Heart Rate</div><div class="v"><span id="bpm">--</span> <span class="u">BPM</span></div><div id="hrbadge" class="badge hold">--</div></div>
  <div class="card"><div class="k">Heart SQI</div><div class="v" id="sqi">--</div><div class="u" id="hrhold"></div></div>
  <div class="card"><div class="k">Respiration (aux)</div><div class="v"><span id="rpm">--</span> <span class="u">RPM</span></div><div class="u" id="rrhold"></div></div>
  <div class="card"><div class="k">ROI / FPS</div><div class="v" id="roi" style="font-size:18px">--</div><div class="u" id="fps"></div></div>
</div>
<div class="chart"><canvas id="chart" height="90"></canvas></div>
<footer id="foot">demo only — not a medical device · SpO2/BP not implemented</footer>
<script>
const ctx=document.getElementById('chart');
const chart=new Chart(ctx,{type:'line',data:{labels:[],datasets:[
 {label:'HR (BPM)',data:[],borderColor:'#5fd48a',yAxisID:'y',tension:.3,spanGaps:true,pointRadius:0},
 {label:'SQI',data:[],borderColor:'#e6c34a',yAxisID:'y1',tension:.3,spanGaps:true,pointRadius:0},
]},options:{animation:false,scales:{
 y:{position:'left',suggestedMin:40,suggestedMax:160,title:{display:true,text:'BPM'},ticks:{color:'#8a93a2'},grid:{color:'#232733'}},
 y1:{position:'right',min:0,max:1,title:{display:true,text:'SQI'},ticks:{color:'#8a93a2'},grid:{display:false}},
 x:{ticks:{color:'#8a93a2',maxTicksLimit:8},grid:{color:'#232733'}}},
 plugins:{legend:{labels:{color:'#c9cfda'}}}}});

function badge(sqi){ if(sqi==null)return['--','hold']; if(sqi>=0.70)return['Reliable','rel']; if(sqi>=0.50)return['Usable','use']; return['Hold','hold'];}
async function tick(){
 try{
  const L=await (await fetch('/api/latest')).json();
  document.getElementById('privacy').textContent=L.privacy||'';
  if(L.status==='waiting'){document.getElementById('foot').textContent=L.message;return;}
  document.getElementById('bpm').textContent=(L.heart_bpm==null||L.heart_sqi<0.5)?'--':L.heart_bpm.toFixed(0);
  document.getElementById('sqi').textContent=L.heart_sqi==null?'--':L.heart_sqi.toFixed(2);
  const [bt,bc]=badge(L.heart_sqi); const b=document.getElementById('hrbadge'); b.textContent=bt; b.className='badge '+bc;
  document.getElementById('hrhold').textContent=L.heart_hold_reason?('hold: '+L.heart_hold_reason):'';
  document.getElementById('rpm').textContent=(L.resp_rpm==null||L.resp_sqi<0.35)?'--':L.resp_rpm.toFixed(0);
  document.getElementById('rrhold').textContent=L.resp_hold_reason?('hold: '+L.resp_hold_reason):'';
  document.getElementById('roi').textContent=(L.roi_name||'--')+(L.lowfreq_applied==='1'?' +LF':'');
  document.getElementById('fps').textContent=(L.fps==null?'':(L.fps.toFixed(0)+' fps'))+(L.scenario?(' · '+L.scenario):'');
  const S=await (await fetch('/api/series?n=180')).json();
  chart.data.labels=S.t.map(x=>x==null?'':x.toFixed(0));
  chart.data.datasets[0].data=S.heart_bpm;
  chart.data.datasets[1].data=S.heart_sqi;
  chart.update();
 }catch(e){/* 서버 대기 */}
}
setInterval(tick,1000); tick();
</script>
</body></html>
"""


def selftest() -> bool:
    print("=== dashboard SELFTEST (TestClient) ===")
    try:
        from fastapi.testclient import TestClient
    except Exception as exc:
        print(f"  SKIP: TestClient 사용 불가({exc})")
        return True

    import tempfile
    tmp = Path(tempfile.mkdtemp()) / "m.csv"
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["elapsed_sec", "heart_bpm", "heart_sqi", "heart_status", "heart_hold_reason",
                    "resp_rpm", "resp_sqi", "resp_status", "resp_hold_reason", "roi_name",
                    "skin_pixel_count", "skin_ratio", "brightness", "roi_jitter_px",
                    "peak_snr_db", "hr_band_energy_ratio", "q_snr", "q_energy", "q_motion",
                    "lowfreq_applied", "scenario", "fps", "heart_alert", "resp_alert"])
        for i in range(10):
            w.writerow([f"{i*0.5:.3f}", f"{72+i:.2f}", "0.82", "ok", "",
                        f"{15+i%3:.2f}", "0.6", "ok", "", "multi",
                        "4200", "0.9", "150", "1.2", "22.0", "0.95", "0.99", "0.9", "1.0",
                        "1", "static", "18.0", "0", "0"])

    app = create_app(str(tmp))
    c = TestClient(app)

    r_home = c.get("/"); c1 = r_home.status_code == 200 and "TouchFree Vitals" in r_home.text
    r_lat = c.get("/api/latest").json()
    c2 = r_lat["status"] == "ok" and abs(r_lat["heart_bpm"] - 81.0) < 1e-6 and r_lat["scenario"] == "static"
    c3 = "원본" in r_lat["privacy"]
    r_ser = c.get("/api/series?n=5").json()
    c4 = len(r_ser["t"]) == 5 and len(r_ser["heart_bpm"]) == 5

    # 빈/부재 CSV -> waiting
    app2 = create_app(str(tmp.parent / "nope.csv"))
    c5 = TestClient(app2).get("/api/latest").json()["status"] == "waiting"

    for name, ok in [("home 200", c1), ("latest ok", c2), ("privacy stmt", c3),
                     ("series n=5", c4), ("missing->waiting", c5)]:
        print(f"  {'OK' if ok else 'XX'} {name}")
    ok = all([c1, c2, c3, c4, c5])
    print(f"=== RESULT: {'PASS' if ok else 'FAIL'} ===")
    return ok


def main() -> int:
    p = argparse.ArgumentParser(description="TIENG 로컬 대시보드")
    p.add_argument("--csv", type=str, default="measurements.csv", help="rppg_demo_v4 --log 경로")
    p.add_argument("--host", type=str, default="127.0.0.1", help="바인딩 호스트(기본 로컬만)")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args()

    if args.selftest:
        return 0 if selftest() else 1

    try:
        import uvicorn
    except Exception:
        print("uvicorn 미설치: pip install uvicorn")
        return 1
    print(f"[dashboard] http://{args.host}:{args.port}  (csv={args.csv})")
    print(f"[privacy] {PRIVACY_STATEMENT}")
    uvicorn.run(create_app(args.csv), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
