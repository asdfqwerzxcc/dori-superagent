# dori 저장소 운영 (dori 고유) — 2026-11-20

이 문서는 **dori 저장소 자체를 운영하는 규칙**이다. 프로젝트 일반 워크플로우는 `docs/workflow.md`에 있고, 여기 내용은 **dori에만 해당**한다. 새 프로젝트에 복사하지 않는다.

## 리모트

| 리모트 | 저장소 | 역할 |
|---|---|---|
| `origin` | `sisyphuslabs/dori-superagent` | **업스트림**. fetch만. push/PR 금지 |
| `fork` | `asdfqwerzxcc/dori-superagent` | 우리 작업 원격. **레인 PR 대상 = `fork:main`** |
| `local` | `~/.dori/remotes/dori.git` | 로컬 미러(백업) |

- 업스트림 반영: 업스트림 커밋은 `fork/main`(또는 업스트림 동기화 PR)을 거쳐 들어온다. 로컬 main이 리모트보다 **뒤처져 있을 때만** `git fetch <remote>` → `git merge --ff-only <remote>/main`을 쓴다. 로컬 main에 레인/PR 커밋이 앞서 있으면 fast-forward는 실패하므로 `fork/main`을 merge하거나 업스트림 동기화 PR을 머지한다. `fork/main` 직접 push는 금지한다.
- `fork:main` = 우리 통합 브랜치. 업스트림 미러가 아니다.

## CI

- `.github/workflows/ci.yml` — PR(`main` 대상)에서 `bun install → typecheck → test`. 무료 티어에서 런당 ~15초.
- 업스트림에서 물려받은 `cla.yml`은 **포크에서 실패**하고 `pull_request_target`+write 권한이라 위험 → 삭제. 그 테스트(`test/cla-precheck.test.ts`)도 함께 제거.

## Contribution graph(잔디) — dori 고유 이슈

- **fork 저장소 커밋은 잔디에 집계되지 않는다**(GitHub 정책). 우리는 `fork` 저장소로 푸시하므로 잔디가 비어 보인다.
- 해결책(선택): **비포크 개인 리포**(예: `asdfqwerzxcc/dori`)를 하나 두고 머지 결과를 한 번 더 푸시한다. 이건 **dori 저장소 운영 편의**이지 프로젝트 워크플로우의 일부가 아니다.
- 커밋 이메일이 GitHub 계정에서 verified여야 기여로 집계된다.

## 릴리스/업데이트

- 스킬 배포: `skills/dori-mode` (npm/`bun link`로 PATH).
- 하네스 재시작: 코드 변경 후 실행 중 동작을 반영하려면 `dori restart`(≈4초, duty·loop·plugin). 리드는 유휴 시점에 재시작.

## 금지

- `origin`(업스트림)으로의 push/PR — 어떤 경우에도.
- `fork:main` 직접 push는 금지한다. 레인은 `dori merge <key>`로 PR을 만들어 머지하고, `dori doctor`의 merge guard가 PR 없는 main 이동을 경고한다.
