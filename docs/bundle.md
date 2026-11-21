# dori bundle — 로컬 PR 묶음 → MR 1개

`lane/<key>` 로컬 브랜치(+ 영수증)들을 하나의 `bundle/<id>`로 합치고, **MR 한 개**를 우리 포크에 연다. "한 번들 = 한 게이트"를 도구로 강제한다.

## 명령

```
dori bundle open <id> --title T [--issue N] [--repo owner/name]
dori bundle add  <id> <lane-key>...     # 레인 영수증이 CLEAR이고 그 sha가 lane/<key> head일 때만
dori bundle list [<id>] [--json]
dori bundle show <id> [--json]
dori bundle land <id> [--dry-run]       # bundle/<id> 생성 + 멤버 --no-ff 머지 + 포크 push + PR 생성/갱신
dori bundle close <id> [--text T]       # PR 머지 후: 대표 이슈만 Closes 확인, 나머지 Refs 코멘트
```

- 기록: `state/bundles/<id>.json` — `{id, title, issue, repo, branch, pr, status, members:[{lane, sha, verdict, reviewer}]}`

## 규칙

1. **`add` 게이트(레인 게이트 모드)**: 레인 영수증이 **CLEAR**이고, 그 영수증의 sha가 **현재 `lane/<key>` head와 일치**할 때만 추가된다. 없음/BLOCK/stale sha는 `Refusal`로 거부되고 번들은 바뀌지 않는다.
2. **`land`**: `main`에서 `bundle/<id>`를 만들고 멤버 브랜치를 적힌 순서대로 `--no-ff` 머지한다. 충돌하면 **그 자리에서 멈추고 부분 브랜치를 남긴다**(조용히 넘어가지 않는다). 성공하면 `fork`로 푸시하고 `.github/PULL_REQUEST_TEMPLATE.md` + 멤버 목록으로 PR을 만들거나 갱신한다.
3. **`merge --bundle <id>`**: 게이트는 둘 중 하나를 만족해야 한다.
   - ⑴ PR head에 **CLEAR 영수증**이 있다(번들 단위 리뷰), 또는
   - ⑵ 기록된 **구성원 전원이 자기 sha에서 CLEAR**이고 **체크가 green**이다.
   우회 플래그는 없다.
4. **`close`**: PR이 MERGED 된 뒤에만 동작. 대표 이슈 외의 `Closes`가 있으면 거부하고, 구성원 영수증에 대한 `Refs` 코멘트를 한 번 남긴 뒤 번들을 closed로 표시한다.

## 두 리뷰 모드와의 관계

- **번들 게이트 모드**: 레인은 커밋만, `dori review <fork/repo#N>`로 MR head에서 한 번 리뷰 → `dori merge`.
- **레인 게이트 모드(회사 방식)**: 레인마다 `dori review --lane <key>` → `bundle add`가 CLEAR+sha를 검사 → `dori merge --bundle <id>`가 구성원 영수증과 체크로 판정.

자세한 배경은 `docs/workflow.md` §3.5.

## 아직 없는 것

- Gate inbox 화면 없음: 판단은 번들 MR 리뷰 화면에서 하고 `dori sop gate show`/`sync`가 근거와 영수증을 잇는다.
- `land`는 포크만 대상으로 한다(업스트림 금지). `bundle/<id>`를 로컬에서만 유지하는 옵션은 없다.
