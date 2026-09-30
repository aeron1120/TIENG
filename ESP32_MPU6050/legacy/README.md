# 이전 합성 모델 자료

이 폴더는 현재 데이터의 측정 파일명과 혼동하지 않도록 이전 모델 자료를 분리한 곳입니다. 사용자가 현재 자료를 실제 실험 데이터라고 확인한 내용을 현재 `../README.md`에 기록했습니다.

- `legacy_model_assumptions.json`: 이전 설정 그대로 보존. `physical_tests_performed=0`은 현재 실험의 수행 횟수가 아님.
- `generate_synthetic.py`: 기존 수치 생성 모델. 출력은 이 폴더의 `generated/data/MODEL_*`.
- `make_synthetic_figures.py`: 위 모델 출력으로 모델 그래프·계산표 생성.
- `build_synthetic_report.py`: 위 모델 출력으로 모델 보고서 생성.

이 코드들은 현재 `../data/REAL_*`를 출력 대상으로 사용하지 않습니다. 원본 코드와 문구는 상위 `_backup/filename_cleanup_20260930.zip`에도 보존됩니다.
