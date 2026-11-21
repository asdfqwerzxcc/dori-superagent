# dori 문서 지도

무엇이 어디에 있는지 한 장으로. **구현** = 지금 코드에 있음, **계획** = 문서만, **레퍼런스** = 조사해 둔 참고 자료.

## 운영 · 워크플로우

| 문서 | 상태 | 내용 |
|---|---|---|
| [workflow.md](workflow.md) | 구현 | 표준 워크플로우: 레인(로컬 PR) → 번들 → MR → CI → 게이트 → 머지. 두 리뷰 모드(번들/레인) |
| [ops-protocol.md](ops-protocol.md) | 구현 | 브랜치 이름, 번들 규칙, PR 템플릿, `dori labels`/`dori stale` |
| [lane-isolation.md](lane-isolation.md) | 구현 | 레인별 워크트리 격리 |
| [hourly-loop.md](hourly-loop.md) | 구현 | 시간당 루프: 백로그 시작·동기화·질문 |
| [supervision.md](supervision.md) | 구현 | supervisor·watchdog·플러그인 상주 구조 |
| [review.md](review.md) | 구현 | 리뷰 게이트와 영수증 |
| [dori-repo-ops.md](dori-repo-ops.md) | 구현 | **dori 저장소 자체** 운영(리모트·CI·잔디·재시작). 프로젝트에 복사하지 않음 |

## 컴포넌트 (이번 주 추가된 것)

| 문서 | 상태 | 내용 |
|---|---|---|
| [board.md](board.md) | 구현 | Vercel Board 모델의 로컬 이식: 태스크=스레드, 리스, `needs` DAG |
| [sop.md](sop.md) | 구현 | SOP 정의/런, 한 번들=한 게이트, `sop gate` 영수증 |
| [bundle.md](bundle.md) | 구현 | 레인 영수증 게이트, `bundle land`로 MR 1개, `merge --bundle` |
| [dori-link.md](dori-link.md) | 구현 | LAN 페어링(8자 코드+지문), `dori devices` |
| [portable-install.md](portable-install.md) | 구현 | 새 머신/회사 PC 준비물, `dori doctor`, `DORI_HOME` 분리 |
| [plugins.md](plugins.md) | 구현 | 플러그인 레지스트리 |
| [runtime.md](runtime.md) | 구현 | herdr/hc 런타임 추상 |
| [container.md](container.md) | 구현 | 컨테이너 실행 |

## 설계 · 결정 (날짜 문서)

| 문서 | 상태 | 내용 |
|---|---|---|
| [final-plan-2026-11-20.md](final-plan-2026-11-20.md) | 계획 | Helmr/dori/up.computer 3층, 토폴로지, 순서 |
| [dori-topology-2026-11-20.md](dori-topology-2026-11-20.md) | 계획 | 메인(PM)·프로젝트 도리, 다채널 인박스, 원격 데몬 |
| [helmr-review-2026-11-20.md](helmr-review-2026-11-20.md) | 계획 | Helmr 거버넌스 계층, SOP 판단 UI 스펙 |
| [goat-omo-dori-loopforge-plan-2026-11-20.md](goat-omo-dori-loopforge-plan-2026-11-20.md) | 레퍼런스 | GOAT 개조안(포크 비권장) |
| [dori-multi-machine-options-2026-11-19.md](dori-multi-machine-options-2026-11-19.md) | 레퍼런스 | 원격 실행 선택지 4개 비교 |
| [loopforge-assessment-2026-11-19.md](loopforge-assessment-2026-11-19.md) | 레퍼런스 | LoopForge 소스 조사 |
| [loopforge-role-plan-2026-11-19.md](loopforge-role-plan-2026-11-19.md) | 레퍼런스 | LoopForge 역할 경계 |
| [t3code-gitlab-integration-2026-11-20.md](t3code-gitlab-integration-2026-11-20.md) | 레퍼런스 | T3 Code의 GitLab 연동 방식(glab CLI + api) |
| [four-chat-options-2026-11-19.md](four-chat-options-2026-11-19.md) | 레퍼런스 | Zulip/Mattermost/Element/Orbit 비교 |
| [glm-5.3-vs-deepseek-v4.1-flash.md](glm-5.3-vs-deepseek-v4.1-flash.md) | 레퍼런스 | 모델 비교(스냅샷 주의) |
| [omo-model-profiles-luna-astra.md](omo-model-profiles-luna-astra.md) | 레퍼런스 | 모델 프로필 |
| [omo-stats-ui-plan-2026-11-19.md](omo-stats-ui-plan-2026-11-19.md) | 계획 | omo-stats 화면 계획(보류) |
| [model-context-capture.md](model-context-capture.md) | 레퍼런스 | 모델 컨텍스트 캡처 |
| [agentes-chat-symptoms-and-fixes.md](agentes-chat-symptoms-and-fixes.md) | 레퍼런스 | 과거 사례 |

## 규칙

- 문서를 추가하면 **이 목록에도 한 줄** 넣는다(상태 포함).
- 날짜 문서는 결정 기록으로 남기고, 현행 규칙은 날짜 없는 문서(workflow, ops-protocol 등)에 둔다.
- 레퍼런스 문서는 "채택/보류/폐기"를 첫 문단에 적는다.
