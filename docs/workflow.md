# 표준 워크플로우 (모든 프로젝트 공통) — 2026-11-23 갱신

Lee: "이게 나의 정형적인 워크플로우가 될 거야. 어떠한 프로젝트를 해도 지금 dori 쪽에 반영하는 것은 **테스트하면서 맞춘다**고 생각하자."

즉 **dori 저장소가 이 워크플로우의 기준 구현(reference)** 이고, 새 프로젝트는 이걸 복제해 쓴다. 워크플로우 자체를 바꿀 때는 **dori에서 먼저 고치고 테스트로 고정한 뒤** 각 프로젝트에 전파한다.

## 1. 단위

| 단위 | 무엇 | 어디에 있나 |
|---|---|---|
| **레인** | 레인 하나 = 워크트리 + 브랜치 + 영수증 | `worktrees/<key>`, 브랜치 `lane/<key>` |
| **레인 PR(기본)** | 레인 1개 = PR 1개 = 게이트 1회 | `lane/<key>` → 레인 레포의 main |
| **번들(선택)** | 여러 레인을 한 PR로 묶을 때만 | `bundle/<id>` 통합 브랜치 → 레인 레포의 main |
| **게이트** | 레인별 리뷰 영수증 | `dori review --lane <key>`(요청) → `dori review <owner/repo#N> --background`(자체 세션 리뷰) → `dori review <key> --attest`(영수증) → `dori merge <key>` |

## 2. 흐름

1. **요구 → 백로그**: 메시징/PM 도리가 요구를 백로그 항목 + 브리프로 만든다.
2. **레인**: `dori start <key> --brief <f>` → 워크트리에서 작업 → **로컬 커밋** → `dori ready`(증거 링크).
3. **리뷰 게이트(레인)**: `dori review --lane <key>`가 요청과 diff를 기록하고, 리뷰를 `dori review <owner/repo#N> --background`의 자체 세션에서 돌린 뒤 `dori review <key> --attest`로 그 head에 묶인 **CLEAR 레인 영수증**을 쓴다. `--background`는 즉시 반환하고 duty는 요청·작업 상태와 진행을 보고하며 리뷰어를 띄우지 않는다. 리뷰 천장은 2시간 또는 250000 토큰 중 먼저 닿는 쪽이다(`src/worker-limits.ts`). 천장에 닿으면 리뷰어가 안전 지점에서 멈춰 미검증 항목을 남기고, 하나라도 HIGH/MEDIUM을 숨길 수 있으면 BLOCK을 출력한다. duty는 2시간을 넘긴 리뷰를 중단하지 않고 리드에게 1회 알린다. 영수증은 리뷰된 diff의 tip SHA와 `git patch-id`를 함께 기록하므로, rebase로 SHA만 바뀌고 diff가 같으면(컨텍스트 포함) 새 리뷰 없이 유효하다. `--attest`는 저장된 리뷰 diff의 patch-id가 현재 `base..tip`과 같을 때만 통과한다. 없음/BLOCK/다른 패치면 다음 단계로 못 간다.
4. **레인 착지(기본)**: `dori merge <key>`가 ⑴ 영수증을 다시 확인하고 ⑵ `lane/<key>`를 레인 레포의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에 push하고 ⑶ PR을 생성/갱신하고 ⑷ PR 체크가 있으면 전부 green일 때만(없으면 `checks=none`) **merge commit**으로 머지한 뒤 ⑸ 원격 브랜치 삭제를 시도하고, 삭제가 실패하면 머지는 유지한 채 WARN으로 알린다. 체크가 pending/failed면 PR과 브랜치는 남기고 거부하므로, green이 된 뒤 `dori merge <key>`를 다시 실행한다. PR 대상은 `lane.repo`에서 유도하며, design 레포(`asdfqwerzxcc/dori-design-system`, `origin`만 있음)도 같은 기본 경로를 쓴다.
5. **묶음 착지(선택, 명시적 모드)**: 여러 레인을 한 PR로 묶어야 할 때만 `dori bundle open`/`add`/`land` → `dori merge <owner/repo#N> --bundle <id>`. 기본 경로가 아니다.
6. **CI**: 워크플로가 있는 레포는 PR에서 `bun install` → `typecheck` → `test`(무료 티어, 런당 ~15초). 레인/번들 게이트는 체크가 있으면 전부 green이어야 머지하고, 워크플로가 없으면 `checks=none`으로 통과한다.
7. **머지/반영**: `dori merge`가 머지한다(레인 모드 merge commit, 번들 모드 squash). 머지 후 로컬 main은 `git fetch fork`(없으면 `origin`) 후 `git merge --ff-only <remote>/main`으로 동기화하고, `dori done <key>`로 워크트리와 브랜치를 정리한다(`--ff-only`는 로컬 main이 뒤처져 있을 때만; dori 저장소의 예외는 `docs/dori-repo-ops.md`). 실행 중인 하네스(duty/loop/plugins)는 **시작 시점 코드를 계속 실행**하므로 dori 코드가 바뀌면 `dori restart`로 재시작해야 새 규칙이 적용된다.

## 3. 이 워크플로우를 지키는 규칙

- **기본은 레인 게이트**: 레인은 리뷰 영수증을 받은 뒤 `dori merge <key>`로만 원격에 착지한다. push·PR·머지·브랜치 삭제가 한 명령에 묶여 있다.
- **로컬 main 직접 머지 금지**: 레인 브랜치를 로컬 main에 fast-forward로 머지하면 PR 없는 커밋이 생긴다(이미 받아온 자기 리모트의 main으로 fast-forward하는 것은 새 커밋을 만들지 않는다). 그 상태는 `dori doctor`의 merge guard가 경고한다.
- **번들은 묶음 전용**: 여러 레인을 한 MR/한 승인으로 묶을 때만 `dori bundle`을 쓴다. 한 번들 = 한 게이트.
- **우회 플래그 금지**: 영수증 없음, BLOCK, stale sha, PR 체크 pending/failed/없음은 머지 거부다. 우회 플래그를 만들지 않는다.
- dori 쪽 변경은 **테스트로 고정**: 워크플로우 규칙(프롬프트·CLI·게이트)을 바꾸면 그 규칙을 검사하는 테스트나 실행 증거를 같이 남긴다.
- 프로젝트에 전파할 때: `skills/dori-mode`, `.github/workflows/ci.yml`, `prompts/lane-footer.md`, `docs/ops-protocol.md` 네 개를 복사하고 리모트 이름만 바꾼다.

### 브리프 계약 (5항)

모든 레인/서브에이전트 브리프는 다섯 항목을 담는다: **목표**, **입력**, **산출물**, **정지 조건**, **금지(파일 범위)**. 정의와 레인에 주입되는 문구의 단일 소스는 `prompts/lane-footer.md`의 "The brief contract"다. 브리프의 기준이 전부다 — 레인이 브리프 위에 게이트·리뷰 라운드·추가 산출물을 얹지 않는다(하네스 리뷰 게이트와 명시적 `MODE:`는 예외). 기존에 있던 문제는 보고에 한 줄로 남기고 이 레인에서 고치지 않는다.

### 불변조건 우선 (D3+)

불변조건이 필요한 변경은 `DIFFICULTY: D3|D4`, `## Invariants` 절, 또는 상위 카테고리(`deep-high`, `ultrabrain`, `architect`)가 트리거한다. 의무는 모델·카테고리에 따라 둘로 갈린다. 문구의 단일 소스는 `prompts/lane-footer.md`의 "Invariants (D3+)"이고, 같은 문장을 여기에도 둔다:

> Changes that need invariants are triggered by `DIFFICULTY: D3|D4`, an `## Invariants` section, or a high category (`deep-high`, `ultrabrain`, `architect`). The obligations depend on the model or category:
>
> - **flash/default on D3+** (a `DIFFICULTY: D3|D4` brief or an `## Invariants` section, with no high category named): (a) list each invariant with its failure mode; (b) add one test per invariant and capture the failing output on the pre-fix code; (c) fix only what those tests demand; (d) report per invariant the test name and the before/after output.
> - **deep-high / ultrabrain / architect** (even when the brief is D3+): no procedure is enforced; invariants and their evidence are expected deliverables. Document each invariant and cover it with a test. The gate checks that outcome only and does not block for a missed step.

리뷰 게이트는 flash/default D3+에서 실패-선행 증거가 없으면 HIGH로 보고 `VERDICT: BLOCK`하고, 상위 카테고리는 결과만 검사한다(불변조건 문서화 + 각각 테스트 커버, 과정 미준수로 BLOCK하지 않음). `prompts/review.md`와 `prompts/review-lane.md`가 같은 미러를 갖는다.

### 호스트 전역 프로세스 킬 금지

호스트의 모든 인스턴스를 끝내는 종료는 금지한다: `taskkill /IM`, `pkill`, `kill -9`는 금지이고, 종료는 신원(pid + OS start)이 확인된 대상만 한다. 2026-11-26에 한 레인이 `taskkill //F //IM bun.exe`로 리드·duty·모든 레인을 죽였다.

### 천장 (기본값, 보수적)

| 실행 | 시간 | 토큰 | 천장에서 |
| --- | --- | --- | --- |
| 리뷰(PR·레인) | 2시간 | 250000 | 안전 지점에서 멈춤, 미검증 항목 명시, 불완전하면 `VERDICT: BLOCK` |
| 레인 | 3시간 | 400000 | pause-safely: 현재 원자 단계 종료, `wip:` 커밋, `$DORI_HOME/briefs/<key>.state.md`, `--status waiting` |

값의 단일 소스는 `src/worker-limits.ts`이고, `prompts/review.md`·`prompts/review-lane.md`·`prompts/lane-footer.md`·`prompts/duty.md`·`prompts/lead.md`에 렌더된다. 시간은 벽시계이고, 토큰은 워커가 자기 세션에서 읽는 값이다(하네스는 별도 토큰 카운터를 두지 않는다). 하네스는 나이로 실행을 죽이지 않는다: 워커가 스스로 멈추고 보고하며, 리드가 천장을 올릴지 작업을 쪼갤지 결정한다. 천장은 목표가 아니라 안전망이다.

### 안전 정지 (pause-safely)

리드가 재시작/중단을 알리거나 천장에 닿으면: 새 작업을 시작하지 않고 현재 원자 단계를 끝내거나 되돌린 뒤, `lane/<key>`에 `wip:` 커밋 하나로 남기고 `$DORI_HOME/briefs/<key>.state.md`에 의도·진행·검증된 것·미검증·다음 행동·키 파일·gotcha를 쓴다. 리드에게 상태 파일 경로와 재개 첫 행동을 `--status waiting`으로 보고하고 턴을 끝낸다. 다음 턴은 상태 파일을 먼저 읽고 재개한다. 되돌릴 수 없는 행동(push/PR/merge/deploy)은 정지를 위해 새로 하지 않는다.

## 3.5 두 착지 모드 (2026-11-23)

- **레인 게이트(기본)**: `dori review --lane <key>`(요청) → `dori review <owner/repo#N> --background`(자체 세션 리뷰) → `dori review <key> --attest`(영수증) → `dori merge <key>`. 레인마다 리뷰하고 레인마다 PR을 만든다.
- **번들 게이트(명시적)**: `dori bundle add`가 레인 영수증 CLEAR와 sha를 검사하고, `dori merge --bundle <id>`가 구성원 영수증과 체크로 판정한다. 여러 레인을 한 번에 묶을 때만 쓴다.

즉 "리뷰를 어디서 하느냐"만 다르고, **한 번들 = 한 사람 승인** 원칙은 번들 모드에서 유지된다.

### 착지 모드별 정확한 명령

모드의 정의는 위 3.5에서 정리했고, 실행 순서와 전제만 여기 모아 둔다.

| 모드 | 범위 | 정확한 명령 |
| --- | --- | --- |
| **레인 게이트(기본)** | 레인 1개 = 영수증 1개 = PR 1개 | `dori review --lane <key>` → `dori review <owner/repo#N> --background` → `dori review <key> --attest --verdict CLEAR\|BLOCK --reviewer <name> --evidence <link>` → `dori merge <key>` |
| **번들 게이트(선택)** | 여러 레인 = 한 PR, 구성원마다 CLEAR 영수증 | `dori bundle open <id> --title T` → `dori bundle add <id> <lane-key>...` → `dori bundle land <id>` → `dori merge <owner/repo#N> --bundle <id>` |

- `--background`는 PR head가 `dori review --lane`이 녹화한 `lane/<key>@<tip>`의 diff와 같을 때만 그 lane diff로 리뷰한다. head가 다르면 일반 PR 리뷰로 떨어져 lane 영수증이 붙지 않는다.
- `merge --bundle`은 번들 PR head에 CLEAR 영수증이 있거나, 기록된 구성원 전원이 각자의 sha에서 CLEAR일 때 통과한다.

기본은 레인 게이트다. `dori merge <key>` 한 번이 push → PR 생성 → 체크 green(또는 `checks=none`) 확인 → merge commit → 원격 브랜치 삭제 시도(best-effort, 실패하면 머지는 유지한 채 WARN)를 묶어서 한다. 번들은 여러 레인을 한 PR로 묶어야 할 때만 명시적으로 쓴다(`dori bundle open`/`add`/`land`).

## 4. 지금 상태

- 레인 게이트: **있음**(`dori review --lane`(요청) → `dori review <key> --attest`(영수증) → `dori merge <key>` — push → PR → 체크 green → merge commit → 브랜치 삭제)
- 번들 게이트: **있음, 명시적 모드**(`dori bundle`, `dori merge --bundle`)
- 로컬 merge 가드: **있음**(`dori doctor` merge guard)
- CI: **있음**(`.github/workflows/ci.yml`)
- 리뷰 게이트: **있음**(레인 영수증, PR 리뷰)
- 게이트 인박스 UI: **없음**(Helmr)
