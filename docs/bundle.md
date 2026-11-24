# dori bundle — 여러 레인 묶음 → MR 1개 (명시적 모드)

> **기본 착지 경로는 레인 게이트다.** `dori merge <lane-key>`가 레인마다 영수증 확인 → 레인 레포의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`) push → PR → merge commit → 브랜치 삭제를 한다. 이 문서의 번들은 **여러 레인을 한 PR로 묶을 때만** 쓰는 별도 모드다.

`lane/<key>` 브랜치(+ 영수증)들을 하나의 `bundle/<id>`로 합치고, **MR 한 개**를 레인 레포의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에 연다. "한 번들 = 한 게이트"를 도구로 강제한다.

## 명령

```
dori bundle open <id> --title T [--issue N] [--repo owner/name]
dori bundle add  <id> <lane-key>...     # 레인 영수증이 CLEAR이고 그 sha가 lane/<key> head일 때만
dori bundle list [<id>] [--json]
dori bundle show <id> [--json]
dori bundle land <id> [--dry-run]       # bundle/<id> 생성 + 멤버 --no-ff 머지 + 자기 리모트 push + PR 생성/갱신
dori bundle close <id> [--text T]       # PR 머지 후: 대표 이슈만 Closes 확인, 나머지 Refs 코멘트
dori merge <owner/repo#N> --bundle <id> # 명시적 번들 게이트로 머지
```

- 기록: `state/bundles/<id>.json` — `{id, title, issue, repo, branch, pr, status, members:[{lane, sha, verdict, reviewer}]}`

## 규칙

1. **`add` 게이트**: 레인 영수증이 **CLEAR**이고, 그 영수증의 sha가 **현재 `lane/<key>` head와 일치**할 때만 추가된다. 없음/BLOCK/stale sha는 `Refusal`로 거부되고 번들은 바뀌지 않는다.
2. **`land`**: `main`에서 `bundle/<id>`를 만들고 멤버 브랜치를 적힌 순서대로 `--no-ff` 머지한다. 충돌하면 **그 자리에서 멈추고 부분 브랜치를 남긴다**(조용히 넘어가지 않는다). 성공하면 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)로 푸시하고 `.github/PULL_REQUEST_TEMPLATE.md` + 멤버 목록으로 PR을 만들거나 갱신한다.
3. **`merge --bundle <id>`**: 게이트는 둘 중 하나를 만족해야 한다.
   - ⑴ PR head에 **CLEAR 영수증**이 있다(번들 단위 리뷰), 또는
   - ⑵ 기록된 **구성원 전원이 자기 sha에서 CLEAR**이고 **체크가 있으면 green, 없으면 none**이다.
   우회 플래그는 없다.
4. **`close`**: PR이 MERGED 된 뒤에만 동작. 대표 이슈 외의 `Closes`가 있으면 거부하고, 구성원 영수증에 대한 `Refs` 코멘트를 한 번 남긴 뒤 번들을 closed로 표시한다.

## 레인 게이트(기본)와의 관계

- **기본(레인 게이트)**: 레인마다 `dori review --lane <key>`(요청) → `dori review <owner/repo#N>`(자체 세션 리뷰) → `dori review <key> --attest`(영수증) → `dori merge <key>`. 이 문서의 번들 명령은 쓰지 않는다. PR은 `lane.repo`의 자기 리모트(`fork`가 있으면 `fork`, 없으면 `origin`)에 만들고 merge commit으로 머지한다.
- **번들 게이트(명시적)**: 여러 레인을 한 PR/한 승인으로 묶을 때만 `dori bundle` → `dori merge --bundle <id>`. `add`는 CLEAR+sha를, `merge --bundle`은 구성원 영수증과 체크를 판정한다. 단, PR head에 CLEAR 영수증이 있으면 `bundleGate`를 건너뛴다(규칙 3 ⑴).
- **리모트 규칙**: `bundle land`도 `fork`가 있으면 `fork`, 없으면 `origin`으로 푸시하며, 그 리모트가 번들 레포와 같아야 하고 업스트림이면 거부한다.

자세한 배경은 `docs/workflow.md` §3.5.

## 아직 없는 것

- Gate inbox 화면 없음: 판단은 레인 PR(묶음 모드에서는 번들 MR) 리뷰 화면에서 하고 `dori sop gate show`/`sync`가 근거와 영수증을 잇는다.
