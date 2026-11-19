# GLM-5.3 vs DeepSeek-V4.1-Flash(1017) — 비교 조사

출처: llm-stats.com 모델 페이지 및 직접 비교 페이지, benchlm.ai(1017 변형), 2026-11-19 조회.

## 한눈에

| 항목 | DeepSeek-V4.1-Flash | GLM-5.3 |
|---|---|---|
| 제작·출시 | DeepSeek, 2026-09-10 | Zhipu AI(ZAI), 2026-08-14 |
| 파라미터 | 763.2B MoE, 45T tokens 학습 | 753B MoE |
| 컨텍스트 | 입력 1.04M / 출력 393K | 입력 1.05M / 출력 1.05M |
| 멀티모달 | **예(텍스트+이미지 입력)** | 아니오 |
| 라이선스 | **MIT** | GLM-5.3 License(상용 허용, 연매출 $10B 초과 시 보안심사) |
| 가격(최저) | **$0.22/M 입력 · $0.006 캐시 · $0.66/M 출력** (Fireworks) | $1.20/M 입력 · $0.12 캐시 · $4.00/M 출력 (DeepInfra) |
| LLM Stats 점수 | 48.2 | **49.2** |
| benchlm 점수(1017) | 63.85/100, 214개 중 33위 | — |

**가격 차이: 입력 5.5배, 출력 약 6배 DeepSeek이 저렴.**

## 벤치마크 (각 모델이 보고한 항목)

- **DeepSeek-V4.1-Flash**: CodeForces 100.0%, GPQA 90.9%, Terminal-Bench 2.1 **90.6%**, BabyVision 89.6%, CyberGym **88.1%**
- **GLM-5.3**: Terminal-Bench 2.1 88.2%, CyberGym 84.5%, FrontierSWE 78.1%, Toolathlon 73.0%, DeepSWE 1.1 66.9%

**겹치는 항목만 비교하면 DeepSeek 우세**: Terminal-Bench 90.6 vs 88.2, CyberGym 88.1 vs 84.5.
단 GLM이 보고한 **FrontierSWE/DeepSWE/Toolathlon**은 DeepSeek 쪽 수치가 없어 직접 비교 불가(제3자 평가 필요).

## 우리 사용처별 판단

- **리뷰 게이트(코드 리뷰)**: 벤치마크 중복 구간과 비용만 보면 DeepSeek이 유리. 그러나 **실측**에서 DeepSeek는 리뷰 중 600초 무응답이 3회, GLM은 20~80초에 verdict를 냈다 → **현재 기본 리뷰어는 GLM 유지**가 맞다(안정성 우선).
- **대량 잡무·탐색·요약**: DeepSeek(가격 5.5~6배 우위, 이미지 입력 가능).
- **에이전트 장기 실행(툴 루프)**: GLM의 Toolathlon/DeepSWE 수치가 있으나 교차검증이 없어 단정 불가. 실측으로는 GLM이 안정적.
- **멀티모달(스크린샷·이미지 읽기)**: DeepSeek만 가능(GLM-5.3은 텍스트 전용) → 이미지가 필요한 작업은 무조건 DeepSeek.
- **라이선스**: MIT(DeepSeek)가 훨씬 자유롭다. GLM은 상용 허용이지만 조건부.

## 결론

1. **비용·멀티모달·라이선스 = DeepSeek 우세**, **벤치마크 종합점수·출력 길이 = GLM 근소 우세**.
2. 우리 워크로드(리뷰·레인)에서는 **안정성 실측이 결정적**이라 리뷰는 GLM, 잡무·이미지·대량은 DeepSeek으로 이원화가 최적.
3. 1017 변형은 benchlm 기준 63.85/100(33/214). GLM과 같은 지표로 비교하려면 **동일 벤치마크를 양쪽에 돌리는 자체 평가**가 필요하다(현재 자료로는 불가).

## 한계

- 각 모델의 벤치마크 세트가 달라 **동일 조건 비교가 아니다**.
- 지연·처리량(TTFT, throughput)은 llm-stats에서 차트만 제공돼 수치 미확인(UNVERIFIED).
- 가격은 조회 시점 최저가이며 프로바이더·캐시 조건에 따라 달라진다.
