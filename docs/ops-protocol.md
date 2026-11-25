# 운영 프로토콜: 이슈, 레인, PR

이 문서는 dori가 저장소에서 이슈와 PR을 다루는 다섯 가지 규칙과, 그 규칙을 검사하는 두 명령
(`dori labels`, `dori stale`)의 동작을 정의한다. 코드와 CLI 출력은 ASCII를 쓰고, 이 문서는 한국어로 쓴다.

## 1. 브랜치 이름: `feat/<lane-key>-<slug>`

- `lane-key`는 dori 레인/백로그 키다(`ops-protocol`, `web-app-12`).
- `slug`는 무엇을 바꾸는지 2~5 단어로, 소문자와 하이픈만 쓴다. 예: `labels-cli`, `stale-sweep`.
- 전체 예: `feat/ops-protocol-labels-cli`, `feat/web-app-12-login-redirect`.
- 종류 접두사는 `feat/`, `fix/`, `docs/`, `chore/` 중 하나를 쓰고, 나머지 규칙은 같다.
- 랜딩 브랜치는 `main` 하나다. 브랜치 하나에는 태스크 하나만 담는다. 리뷰어가 브랜치 이름만 보고 범위를
  알 수 있어야 한다.

## 2. 하나의 태스크 = 하나의 워크트리 = 하나의 PR

- dori는 레인마다 `$DORI_HOME/worktrees/<key>` 워크트리와 `lane/<key>` 브랜치를 만든다. 사람이 직접 만들 때도
  같은 경계를 지킨다: 태스크마다 워크트리 하나, 그 워크트리에서 커밋한 범위가 곧 PR의 diff다.
- 한 PR은 한 태스크의 변경만 담는다. 다른 태스크의 수정, 포맷 변경, 무관한 리팩터링을 섞지 않는다.
- PR은 레인 레포의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에만 연다. 선택한 리모트가 업스트림(`upstream` 리모트가 같은 저장소를 가리키거나 `sisyphuslabs/*`)이면 `dori merge`가 그 리모트를 이름과 이유와 함께 거부한다. `sisyphuslabs/*`에는 어떤 쓰기도 하지 않는다.
- brief가 시키면 레인이 `lane/<key>`를 push하고 PR을 연다. 레인은 머지하지 않는다; 리드는 영수증과 체크를 확인한 뒤 `dori merge <key>`로 머지한다.
- 레인의 작업은 로컬 커밋과 리뷰 영수증으로 끝내고, 착지는 기본적으로 `dori merge <key>`가 담당한다(푸시 → PR → 체크 green → merge commit → 원격 브랜치 삭제). 번들은 여러 레인을 한 PR로 묶을 때만 명시적으로 쓴다.

### 이슈 묶음(bundle) 규칙

같은 원인이나 같은 범위의 이슈가 여러 개면 PR 하나로 묶을 수 있다.

- 한 묶음은 **최대 10개 이슈**다. 10개를 넘으면 원인별로 PR을 나눈다.
- 대표 이슈 하나만 PR 본문에서 `Closes #N`으로 닫는다.
- 나머지는 `Refs #N`(또는 `Related: #N`)으로 링크하고, PR이 랜딩된 뒤 "이 PR에서 함께 해결됨" 코멘트와 함께
  사람이 닫는다. 자동으로 닫히는 이슈는 대표 하나뿐이다.
- 묶음 PR의 본문에는 왜 하나로 묶었는지 한 줄로 적는다. 리뷰어가 분리 가능성을 판단해야 한다.

### 두 착지 모드: 레인 게이트(기본)와 번들(선택) (2026-11-23)

- **레인 게이트(기본)**: 레인마다 `dori review --lane <key>`로 리뷰 요청을 기록하고, `dori review <owner/repo#N> --background`의 자체 세션 판정을 `dori review <key> --attest`로 영수증에 쓰면, `dori merge <key>`가 레인 브랜치를 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에 푸시해 PR을 연다. PR 체크가 있으면 전부 green일 때 merge commit으로 머지하고, 워크플로가 없으면 `checks=none`으로 머지한다.
- **리뷰 소유자**: `dori review --lane <key>`는 요청만 기록하고 `QUEUED <key> <tip> <job>`을 출력한다. 리뷰는 리드가 `dori review <owner/repo#N> --background`로 자기 workspace의 탭에서 열고, 그 판정을 `dori review <key> --attest --verdict ... --reviewer ... --evidence ...`로 영수증에 쓴다. duty는 요청 상태와 진행 상황을 보고하며 리뷰어를 띄우지 않는다. 리뷰 천장은 2시간 또는 250000 토큰 중 먼저 닿는 쪽이고(값: `src/worker-limits.ts`), 천장에서 리뷰어가 스스로 안전 지점에서 멈춰 미검증 항목을 남기며 불완전하면 BLOCK이다. duty는 2시간을 넘긴 리뷰를 죽이지 않고 리드에게 1회 알린다. 동시 리뷰 수는 메모리(리뷰어당 약 500MB)로만 제한한다. `--background --restart`는 running row를 쓰지 못한 시작만 교체하고, reviewer 전체 출력은 `receipts/<pr>@<sha>.review.txt`(64KB 상한)에 남긴다.
- **번들(선택)**: 여러 레인을 한 PR/한 승인으로 묶어야 할 때만 `bundle/<id>`를 만든다. 대표 이슈 하나만 `Closes`, 나머지는 `Refs`; 게이트는 구성원 영수증 또는 PR head 리뷰다.
- 그래서 기본 원격 단위는 **레인 PR 하나**이고, 사람이 보는 단위도 그 PR이다. 번들은 brief가 레인들을 명시적으로 묶을 때만 등장한다.

### 레인 게이트가 기본값인 이유 (2026-11-23)

- 리뷰가 레인 head에 묶여 범위가 작고, 게이트가 레인마다 하나다. 작은 PR이 검토 비용을 낮춘다.
- 여러 레인을 한 번에 검토해야 할 때만 번들로 묶는다. 번들의 이슈 상한은 10개다. 원인이 다르거나 되돌리기(revert) 단위가 다르면 쪼갠다.
- 번들 MR 본문에는 **묶음 구성원 목록**(`Closes #N` 하나 + `Refs #…` 나머지)과 **왜 묶었는지 한 줄**을 반드시 적는다.

### 일시 정지 상태 파일과 재개 (2026-11-25)

리드가 재시작·중단을 알리거나 레인 천장에 닿으면 레인은 현재 원자 단계에서 멈추고 `$DORI_HOME/briefs/<key>.state.md`에 콜드 스타트용 체크포인트를 남긴다.

- 파일에는 의도, 끝내고 검증한 것, 미검증 항목, 정확한 다음 행동, 키 파일, gotcha를 적는다. 커밋하지 않은 작업은 `lane/<key>`에 `wip:` 커밋 하나로 남긴다.
- **재개 행(resume line)** 은 `Next action:`으로 시작하는 한 줄이다. 다음 행동 하나를 실행할 명령이나 파일 경로까지 적고, 다음 세션은 다른 작업보다 먼저 이 파일을 읽고 그 줄부터 실행한다.
- 상태 파일은 정지 시점의 안내판이지 보고서가 아니다. 레인은 상태 파일 경로와 재개 첫 행동을 리드에게 `--status waiting`으로 알리고 턴을 끝낸다. push·PR·merge·deploy 같은 되돌릴 수 없는 행동은 정지를 이유로 새로 하지 않는다.

## 3. PR 템플릿

`.github/PULL_REQUEST_TEMPLATE.md`는 네 절을 요구한다.

| 절 | 내용 |
| --- | --- |
| `## 무엇` | 바뀌는 것과 사용자가 체감하는 변화 |
| `## 왜` | 필요한 이유, 연결된 이슈(`Closes #N`) |
| `## 막힌 것` | 막힌 것이 없으면 `없음`; 있으면 무엇이 누구를 언제까지 기다리는지 한 줄 |
| `## 검증` | 실행한 명령과 결과, 스크린샷, 로그 링크 |

`## 막힌 것`은 비워 두지 않는다. 막힘이 없으면 `없음`을 쓴다.

## 4. 저장소별 접근과 allowlist

`dori labels`와 `dori stale`는 `config/repos.json`을 읽는다.

```json
{ "allow": ["asdfqwerzxcc/dori-superagent"], "readOnly": [] }
```

- `allow`에 있는 저장소만 `--apply`로 쓸 수 있다. 대소문자는 구분하지 않는다.
- `readOnly`에 있는 저장소는 `allow`에도 있어도 쓰지 못한다. 목록에 없는 저장소는 전부 읽기 전용이다.
- 읽기 전용 저장소에서도 드라이런(dry-run)은 허용된다. 무엇을 바꿀지 출력할 뿐 아무것도 쓰지 않는다.
- `--repo`를 생략하면 현재 체크아웃의 `origin`이 GitHub 저장소일 때 그 이름을 쓴다. `origin`이 없거나
  GitHub가 아니면 `--repo owner/name`을 요구한다.
- 토큰은 저장소 단위 Project Access Token(또는 fine-grained PAT)을 쓴다. 최소 권한:
  Metadata read, Contents read/write, Issues read/write, Pull requests read/write. Projects v2 상태를 쓰는
  저장소만 Projects read/write를 더한다. 조직 전체 토큰, `admin` 권한, 다른 저장소로의 재사용은 금지한다.
- `sisyphuslabs/*`는 allowlist에 절대 넣지 않는다. 이 명령들은 PR을 열지 않고, 브랜치를 푸시하지 않고,
  이슈를 닫지 않는다.
- 이슈 트래커가 꺼진 저장소에서는 PR만 검사하고 `NOTE issues are disabled` 한 줄을 남긴다. 실패가 아니다.

## 5. 라벨 상태 머신: `dori labels`

상태 라벨은 다음 다섯 개이고, 항목(이슈 또는 PR)마다 정확히 하나만 붙는다.

| 라벨 | 뜻 |
| --- | --- |
| `status:triage` | 아직 분류·범위가 정해지지 않음 |
| `status:ready` | 범위가 정해져 시작할 수 있음 |
| `status:in-progress` | 레인이 소유하고 작업 중 |
| `status:blocked` | 사람이나 다른 변경을 기다림 |
| `status:done` | 랜딩되었거나 닫힘 |

`dori labels [--repo R] [--apply]`는 상태 라벨이 **0개이거나 2개 이상인 항목만** 고친다.

- 0개: 열린 항목은 `status:triage`, 닫힌 항목(머지된 PR 포함)은 `status:done`.
- 2개 이상: 닫힌 항목은 `status:done`. 열린 항목은 `blocked` > `in-progress` > `ready` > `triage` > `done`
  순서로 가장 강한 상태를 남기고 나머지를 뗀다. 작업을 숨기는 쪽보다 보이게 두는 쪽을 택한다.
- 이미 정확히 1개면 건드리지 않는다. 그래서 같은 명령을 다시 실행해도 바뀌는 것이 없다(멱등).
- 라벨 이름은 대소문자와 콜론 앞뒤 공백을 무시하고 비교한다(`Status: Ready` = `status:ready`).
- 기본은 드라이런이다. `--apply`가 있을 때만 누락된 상태 라벨을 만들고(`gh label create`) 항목을 고친다.
- 출력 예: `LABEL issue#12 add status:triage (Broken login)`, `LABEL pr#12 remove status:ready (Fix login)`,
  `LABELS asdfqwerzxcc/dori-superagent items=37 changes=1 dry-run`.
- 남길 상태가 이미 붙어 있으면 다시 붙이지 않고 나머지 라벨만 뗀다.

## 6. 오래된 항목 청소: `dori stale`

`dori stale [--repo R] [--days-pr 14] [--days-comment 7] [--apply]`는 움직임이 멈춘 열린 항목을 처리한다.

| 대상 | 조건 | 동작 |
| --- | --- | --- |
| PR | `--days-comment`(기본 7일) 동안 움직임 없음 | 한 줄 사유를 묻는 코멘트 1회 |
| PR | `--days-pr`(기본 14일) 동안 움직임 없음 | 사유를 남기고 닫음 |
| 이슈 | 14일 동안 움직임 없음 | `needs-info` 라벨 추가(닫지 않음) |

- "움직임"은 생성, 항목의 갱신(푸시·리뷰·설명 수정), 그리고 우리가 남긴 표시가 없는 코멘트 중 가장 최근 시각이다.
  우리의 넛지도 `updatedAt`을 바꾸므로, 갱신 시각이 가장 최근 넛지 시각과 같거나 그 이전이면 움직임으로 세지 않는다.
  그래야 7일 넛지가 14일 닫기 시계를 되돌리지 않는다.
- 넛지는 멈춤 구간마다 한 번이다. 이미 넛지를 남겼고 그 뒤 움직임이 없으면 다시 코멘트하지 않는다.
- 이슈는 절대 닫지 않는다. `needs-info`가 이미 있으면 다시 붙이지 않는다. 라벨이 떼진 뒤에도 여전히
  오래되었으면 다시 붙인다.
- 모든 실제 동작은 `$DORI_HOME/state/stale-audit.jsonl`에 한 줄씩 JSON으로 남는다:
  `{"at","repo","kind","number","action","ageDays","ok","error"?}`. 실패도 `ok:false`로 남는다.
  드라이런은 아무것도 쓰지 않으므로 감사 로그도 남기지 않는다.
- 기본은 드라이런이다. `--apply`가 있을 때만 `gh pr comment`, `gh pr close --comment`,
  `gh issue edit --add-label needs-info`를 호출한다.
- 출력 예: `STALE nudge pr#8 age=9d (Fix login)`, `STALE needs-info issue#4 age=20d (Docs)`,
  `STALE asdfqwerzxcc/dori-superagent prs=6 issues=9 actions=2 dry-run`.

## 7. 리드 턴: 조사는 explore, 인바운드는 막지 않는다 (2026-11-24)

- 조사·탐색은 `explore` 서브에이전트가 하고 리드는 결과만 판단하며(한 줄 확인·결정적 읽기는 예외), 긴 작업은 `run_in_background: true`로 돌려 리드 턴을 짧게 끊고 턴 사이에 `dori inbox list lead`로 큐를 확인하며, 인바운드가 늦으면 `dori status`의 게이트웨이·슈퍼바이저 줄과 리드 인박스부터 본다.

## 8. Windows: 레인과 리뷰어는 창을 열지 않는다 (2026-11-24)

- 레인·리뷰어·게이트·QA는 Windows에서 콘솔 프로세스(bun, 게이트, 테스트, QA)를 `detached`, PowerShell
  `Start-Process`, `CREATE_NEW_CONSOLE`로 띄우지 않는다. 부모 콘솔을 상속하거나 `windowsHide: true`/
  `CREATE_NO_WINDOW`로 실행한다. 이 셋은 프로세스가 끝난 뒤에도 Windows Terminal 창을 남긴다
  (2026-11-23 69창, 2026-11-24 10창).
- 터미널 창은 사람만 연다. 레인과 리뷰어는 자기 pane 밖에 새 창을 만들지 않는다.
- 고정 도구를 `~/.dori/tmp`(예: `bun145`) 같은 임시 경로에 풀어 썼다면 작업이 끝날 때 그 경로를 지운다.
  임시 추출본을 띄울 때도 같은 규칙(부모 콘솔 상속 또는 `windowsHide: true`)을 지킨다.

## 운영 순서

1. 이슈가 들어오면 `dori labels` 드라이런으로 상태 라벨 공백·충돌을 확인하고, 확인 후 `--apply`.
2. `status:ready`인 항목을 레인으로 시작한다. 레인 하나 = 워크트리 하나 = PR 하나.
3. PR 본문은 템플릿의 네 절을 채운다. 여러 이슈를 묶었다면 대표 하나만 `Closes`, 나머지는 `Refs`와
   랜딩 후 코멘트로 닫는다(최대 10개).
4. 주기적으로 `dori stale` 드라이런을 보고, 오래된 PR·이슈를 정리한 뒤 `--apply`.
5. 쓰기는 allowlist가 허용한 저장소에서만 한다. `sisyphuslabs/*`는 읽기 전용이며, `dori labels`/`dori stale`는 PR을 열지 않는다.
