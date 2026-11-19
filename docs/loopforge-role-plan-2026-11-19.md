# LoopForge 역할 정의 (기획 확정안) — 2026-11-19

목적: 도입 전에 **역할 경계**를 먼저 확정한다. "누가 무엇을 소유하는가"가 정해지지 않으면 도구를 붙여도 운영이 갈라진다.
전제: LoopForge 서버 모드(소스 확인: `compose.yaml` 2서비스 + Docker 샌드박스), dori는 이 머신의 하네스, 사람은 승인자.

## 0. 한 줄 정의

**LoopForge = 실행 공장(샌드박스 + SOP), dori = 작업 관리자(레인·브리프·리뷰·PR 상태), 사람 = 승인자(뭉터기 MR).**

## 1. 소유권 표

| 영역 | LoopForge | dori | 사람 |
|---|---|---|---|
| 작업 실행 환경 | **소유** — Docker 샌드박스, 리포 체크아웃, 실행기(runner) | 로컬 worktree (LoopForge 없이도 동작) | — |
| 워크플로 정의 | **소유** — SOP(노드: agent/script/approval/sop), 플레이북 | 브리프(단일 파일) + 게이트 | SOP 승인 |
| 산출물 | **소유** — 아티팩트 저장·조회 | 커밋·문서·영수증 | — |
| 승인 게이트 | UI의 approval 노드(`waiting_approval`) | 리뷰 게이트 + 영수증 | **최종 승인** |
| 이슈/라벨 상태 | (GitHub/TAPD/Gongfeng 연동) | **소유** — `dori labels`/`dori stale` 상태머신 | 규칙 승인 |
| PR 라이프사이클 | MR **생성은 GitHub API/Gongfeng MCP만** | **소유** — 브랜치 승격, PR 본문, 상태 추적 | 뭉터기 MR 승인·머지 |
| 다중 머신 | 실행기로 확장 가능 | **소유** — ssh 실행 + `local/<machine>/<key>` 회수 | — |
| 대화/보고 | 웹 UI(중국어 원문 + 영어 치환) | Discord(한국어) | — |

## 2. 데이터 계약 (경계에서 오가는 것)

1. **입력**: dori가 만든 **브리프 파일**(목표·범위·검증·정지조건) → LoopForge SOP의 입력(이슈 또는 대화 요구).
2. **출력**: `local/<machine>/<key>` 브랜치 + 아티팩트(무엇/왜/막힌 것/검증).
3. **전송**: 공유 리모트의 `refs/heads/local/**` (메시지 버스 없음 — 확정).
4. **상태**: 대상 리포의 `status:*` 라벨(도구가 유일한 진실원). LoopForge 쪽 상태는 참고용.

## 3. 하지 않는 것 (경계 밖)

- LoopForge에 **라벨 상태머신·stale 스윕을 중복 구현하지 않는다**(dori 도구가 소유).
- dori에 **샌드박스·SOP 편집 UI를 만들지 않는다**.
- 머신 간 **메시징/하트비트/락 네임스페이스**는 만들지 않는다(불필요 — 2026-11-19 확정).
- LoopForge **Local(레거시)** 을 팀 오케스트레이터로 쓰지 않는다.

## 4. 도입 단계

- **P0 (지금)**: 이 문서 승인. 결정 4개(아래) 확정.
- **P1**: `glab` 백엔드 — 사내 GitLab에서 `dori labels`/`dori stale` 동작(회사 업무 경로 우선).
- **P2**: LoopForge 서버 PoC 1건 — GitHub 리포로 end-to-end, SOP 1개 작성, 승인 게이트 1회 통과.
- **P3**: 사내 GitLab 연결 — SOP `script` 노드에서 `glab mr create`, 생성된 MR이 추적되는지 확인.
- **P4**: 다중 머신 래퍼(`dori remote`, 백로그 p5).

## 5. 결정이 필요한 4개

1. **서버 위치**: 어느 머신/호스트에 LoopForge를 올릴 것인가(상시 켜둘 서버 1대).
2. **한국어화**: 중국어 원문 + 영어 치환 구조라 한국어는 추가 개발. (a) 영어 UI로 쓰고 한국어는 Discord 보고로 대체 / (b) 한국어 사전 추가.
3. **첫 대상 SCM**: GitHub(포크)로 PoC → GitLab 확장 / 아니면 곧바로 사내 GitLab.
4. **SOP 소유권**: SOP를 LoopForge에 두고 dori는 브리프만 넘긴다(권장) / SOP를 dori 쪽 파일로 두고 LoopForge는 실행만.

## 6. 근거 자료

- 소스 조사: `docs/loopforge-assessment-2026-11-19.md` (file:line 인용)
- 채팅 플랫폼 비교: `docs/four-chat-options-2026-11-19.md`
- 이미 착지한 도구: `docs/ops-protocol.md` (`dori labels`, `dori stale`, PR 템플릿, allowlist)
