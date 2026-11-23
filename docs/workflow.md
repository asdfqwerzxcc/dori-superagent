# 표준 워크플로우 (모든 프로젝트 공통) — 2026-11-23 갱신

Lee: "이게 나의 정형적인 워크플로우가 될 거야. 어떠한 프로젝트를 해도 지금 dori 쪽에 반영하는 것은 **테스트하면서 맞춘다**고 생각하자."

즉 **dori 저장소가 이 워크플로우의 기준 구현(reference)** 이고, 새 프로젝트는 이걸 복제해 쓴다. 워크플로우 자체를 바꿀 때는 **dori에서 먼저 고치고 테스트로 고정한 뒤** 각 프로젝트에 전파한다.

## 1. 단위

| 단위 | 무엇 | 어디에 있나 |
|---|---|---|
| **레인** | 레인 하나 = 워크트리 + 브랜치 + 영수증 | `worktrees/<key>`, 브랜치 `lane/<key>` |
| **레인 PR(기본)** | 레인 1개 = PR 1개 = 게이트 1회 | `lane/<key>` → 레인 레포의 main |
| **번들(선택)** | 여러 레인을 한 PR로 묶을 때만 | `bundle/<id>` 통합 브랜치 → 레인 레포의 main |
| **게이트** | 레인별 리뷰 영수증 | `dori review --lane <key>` → `dori merge <key>` |

## 2. 흐름

1. **요구 → 백로그**: 메시징/PM 도리가 요구를 백로그 항목 + 브리프로 만든다.
2. **레인**: `dori start <key> --brief <f>` → 워크트리에서 작업 → **로컬 커밋** → `dori ready`(증거 링크).
3. **리뷰 게이트(레인)**: `dori review --lane <key>` → 그 head에 묶인 **CLEAR 레인 영수증**. 없음/BLOCK/stale sha면 다음 단계로 못 간다.
4. **레인 착지(기본)**: `dori merge <key>`가 ⑴ 영수증을 다시 확인하고 ⑵ `lane/<key>`를 레인 레포의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에 push하고 ⑶ PR을 생성/갱신하고 ⑷ **PR 체크가 전부 green일 때만** **merge commit**으로 머지한 뒤 ⑸ 원격 브랜치 삭제를 시도하고, 삭제가 실패하면 머지는 유지한 채 WARN으로 알린다. 체크가 pending/failed/없음이면 PR과 브랜치는 남기고 거부하므로, green이 된 뒤 `dori merge <key>`를 다시 실행한다. PR 대상은 `lane.repo`에서 유도하며, design 레포(`asdfqwerzxcc/dori-design-system`, `origin`만 있음)도 같은 기본 경로를 쓴다.
5. **묶음 착지(선택, 명시적 모드)**: 여러 레인을 한 PR로 묶어야 할 때만 `dori bundle open`/`add`/`land` → `dori merge <owner/repo#N> --bundle <id>`. 기본 경로가 아니다.
6. **CI**: PR에서 `bun install` → `typecheck` → `test`(무료 티어, 런당 ~15초). 레인 게이트와 번들 게이트 모두 이 체크가 green이어야 머지한다.
7. **머지/반영**: `dori merge`가 머지한다(레인 모드 merge commit, 번들 모드 squash). 머지 후 로컬 main은 `git fetch fork`(없으면 `origin`) 후 `git merge --ff-only <remote>/main`으로 동기화하고, `dori done <key>`로 워크트리와 브랜치를 정리한다. 실행 중인 하네스(duty/loop/plugins)는 **시작 시점 코드를 계속 실행**하므로 dori 코드가 바뀌면 `dori restart`로 재시작해야 새 규칙이 적용된다.

## 3. 이 워크플로우를 지키는 규칙

- **기본은 레인 게이트**: 레인은 리뷰 영수증을 받은 뒤 `dori merge <key>`로만 원격에 착지한다. push·PR·머지·브랜치 삭제가 한 명령에 묶여 있다.
- **로컬 main 직접 머지 금지**: 레인 브랜치를 로컬 main에 fast-forward로 머지하면 PR 없는 커밋이 생긴다(이미 받아온 자기 리모트의 main으로 fast-forward하는 것은 새 커밋을 만들지 않는다). 그 상태는 `dori doctor`의 merge guard가 경고한다.
- **번들은 묶음 전용**: 여러 레인을 한 MR/한 승인으로 묶을 때만 `dori bundle`을 쓴다. 한 번들 = 한 게이트.
- **우회 플래그 금지**: 영수증 없음, BLOCK, stale sha, PR 체크 pending/failed/없음은 머지 거부다. 우회 플래그를 만들지 않는다.
- dori 쪽 변경은 **테스트로 고정**: 워크플로우 규칙(프롬프트·CLI·게이트)을 바꾸면 그 규칙을 검사하는 테스트나 실행 증거를 같이 남긴다.
- 프로젝트에 전파할 때: `skills/dori-mode`, `.github/workflows/ci.yml`, `prompts/lane-footer.md`, `docs/ops-protocol.md` 네 개를 복사하고 리모트 이름만 바꾼다.

## 3.5 두 착지 모드 (2026-11-23)

- **레인 게이트(기본)**: `dori review --lane <key>` → `dori merge <key>`. 레인마다 리뷰하고 레인마다 PR을 만든다.
- **번들 게이트(명시적)**: `dori bundle add`가 레인 영수증 CLEAR와 sha를 검사하고, `dori merge --bundle <id>`가 구성원 영수증과 체크로 판정한다. 여러 레인을 한 번에 묶을 때만 쓴다.

즉 "리뷰를 어디서 하느냐"만 다르고, **한 번들 = 한 사람 승인** 원칙은 번들 모드에서 유지된다.

## 4. 지금 상태

- 레인 게이트: **있음**(`dori review --lane`, `dori merge <key>` — 영수증 → push → PR → 체크 green → merge commit → 브랜치 삭제)
- 번들 게이트: **있음, 명시적 모드**(`dori bundle`, `dori merge --bundle`)
- 로컬 merge 가드: **있음**(`dori doctor` merge guard)
- CI: **있음**(`.github/workflows/ci.yml`)
- 리뷰 게이트: **있음**(레인 영수증, PR 리뷰)
- 게이트 인박스 UI: **없음**(Helmr)
