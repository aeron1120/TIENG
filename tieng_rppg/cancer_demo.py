"""
암 진단 AI 데모 (단일 파일 버전)
- 정상세포 vs 암세포의 '핵 크기·모양 불규칙성'을 수치로 학습해 진단
- 실행:  python cancer_demo.py
- 필요:  pip install scikit-learn
"""
import sys

# --- 라이브러리 확인 (없으면 친절히 안내) ---
try:
    import numpy as np
    from sklearn.datasets import load_breast_cancer
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.metrics import accuracy_score, confusion_matrix, roc_auc_score
except ImportError:
    print("scikit-learn이 필요합니다. 먼저 실행하세요:  pip install scikit-learn")
    sys.exit(1)

RANDOM_STATE = 42


def main() -> None:
    # 1) 데이터: 실제 유방암 조직의 세포핵 30개 측정값 (크기/불규칙성 등)
    data = load_breast_cancer()
    X_train, X_test, y_train, y_test = train_test_split(
        data.data, data.target, test_size=0.2,
        random_state=RANDOM_STATE, stratify=data.target,
    )

    # 2) 모델: 값의 단위를 맞춘 뒤(StandardScaler) 로지스틱 회귀로 분류
    model = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(max_iter=5000, random_state=RANDOM_STATE)),
    ])
    model.fit(X_train, y_train)

    # 3) 성능 평가 (모델이 처음 보는 시험 데이터)
    y_pred = model.predict(X_test)
    proba_malignant = model.predict_proba(X_test)[:, 0]   # 악성(0)일 확률
    acc = accuracy_score(y_test, y_pred)
    auc = roc_auc_score(1 - y_test, proba_malignant)
    cm = confusion_matrix(y_test, y_pred)

    print("=" * 50)
    print(" 암 진단 AI 모델 결과")
    print("=" * 50)
    print(f"정확도(Accuracy): {acc:.3f}")
    print(f"AUC 점수       : {auc:.3f}")
    print("[혼동행렬] 행=실제, 열=예측  (0=악성, 1=양성)")
    print(f"  실제:악성   {cm[0][0]:>4}  {cm[0][1]:>4}")
    print(f"  실제:양성   {cm[1][0]:>4}  {cm[1][1]:>4}")
    print(f"  * 위음성(암을 놓친 경우): {cm[0][1]}건\n")

    # 4) 진단 시연 3건
    print("[진단 시연]")
    for i in range(3):
        truth = data.target_names[y_test[i]]
        p = float(model.predict_proba(X_test[i].reshape(1, -1))[0][0])
        verdict = "악성(암 의심)" if p >= 0.5 else "양성(정상에 가까움)"
        print(f"  표본{i}: 실제={truth:<10} → 진단={verdict}  (악성확률 {p:.2f})")


if __name__ == "__main__":
    main()
