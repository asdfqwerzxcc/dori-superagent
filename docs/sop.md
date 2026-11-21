# SOP 모델 + 게이트 큐 (v1)

SOP는 "번들 하나를 어떤 순서로 굴리고, 어디서 사람이 멈추는가"를 파일로 고정한다. dori는 데이터와 CLI만
소유하고 판단 화면은 만들지 않는다. 게이트의 판단 근거는 번들 MR의 코멘트로 게시되고(`gate show`),
사람의 승인/변경 요청은 MR 리뷰로 남으며 `dori sop sync`가 그것을 영수증으로 기록한다. 노드의 실행 자체는
사람이나 레인이 `dori sop step`으로 보고한다.

## 1. 파일

| 경로 | 무엇 |
|---|---|
| `$DORI_HOME/sops/<id>.json` | SOP 정의 |
| `$DORI_HOME/state/sop-runs.json` | 모든 런의 상태. `{ "runs": [ ... ] }` |
| `$DORI_HOME/receipts/sop-<run>-<ts>.json` | 게이트 결정 영수증. 리뷰 영수증과 같은 디렉터리, `sop-` 접두사 |

정의 파일은 다음 모양이다.

```json
{
  "id": "bundle",
  "title": "Bundle flow",
  "nodes": [
    { "id": "implement", "kind": "agent", "prompt": "Implement the bundle." },
    { "id": "approve", "kind": "approval", "bundle": "b-42", "prompt": "Approve the bundle?", "needs": ["implement"] },
    { "id": "verify", "kind": "script", "script": "bun run ci", "needs": ["approve"] }
  ]
}
```

노드 종류는 `agent`, `script`, `approval` 셋뿐이다. `run`은 에이전트가 실행되는 레인/워커 이름,
`script`는 실행할 명령, `prompt`는 에이전트나 리뷰어에게 주는 지시다. `bundle`은 이 노드가 다루는
번들 id이고, `needs`는 이 노드보다 먼저 끝나야 하는 노드 id 목록이다.

### 검증

`dori sop validate <id>`와 모든 읽기 경로가 아래를 검사한다.

- `id`는 파일 이름과 같아야 하고 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`만 쓴다(경로 탈출 방지).
- `kind`는 위 셋 중 하나다.
- 노드 id는 중복될 수 없다.
- `needs`는 존재하는 노드만 가리키고, 순환(`a -> b -> a`)이면 거부한다.
- `bundle`은 선택 필드지만, 값이 있으면 `dori sop run --bundle`과 같은 번들 id 규칙을 따른다.
- `approval` 노드는 비어 있지 않은 `prompt`와 `bundle`이 필수다. 그 번들이 사람이 멈추는 게이트다.
- `approval` 노드는 정의당 최대 하나다. 둘 이상이면 노드 id들을 나열하며 거부한다(한 번들 = 한 게이트).
- `nodes`는 비어 있을 수 없다.

## 2. 런 상태

```json
{
  "runId": "bundle-mbtx1",
  "sop": "bundle",
  "bundle": "b-42",
  "createdAt": 1795189988000,
  "nodes": {
    "implement": { "state": "done", "startedAt": 1795189990000, "endedAt": 1795190100000, "note": "ok" },
    "approve": {
      "state": "done",
      "startedAt": 1795190100000,
      "endedAt": 1795190200000,
      "receipt": "/home/me/.dori/receipts/sop-bundle-mbtx1-2026-11-20T12-34-56-789Z.json"
    },
    "verify": { "state": "waiting" }
  },
  "gate": {
    "state": "approved",
    "node": "approve",
    "since": 1795189988000,
    "by": "lee",
    "at": 1795190200000,
    "note": "looks good"
  }
}
```

노드 상태는 `waiting | running | blocked | done | failed | skipped`다. 허용 전이는 다음과 같다.

| 현재 | 다음 |
|---|---|
| `waiting` | `running`, `blocked`, `failed`, `skipped` |
| `running` | `done`, `failed`, `blocked` |
| `blocked` | `running`, `failed`, `skipped` |
| `failed` | `running`, `waiting` |
| `done`, `skipped` | 없음. 다시 돌리려면 `dori sop rerun` |

`running`으로 갈 때 `needs`가 모두 `done` 또는 `skipped`여야 하고, `done`도 같다. `done`으로 가는
터미널 노드(다른 노드가 `needs`로 가리키지 않는 노드)는 게이트 결정이 끝나 있어야 한다.

## 3. 한 번들 = 한 게이트

정의에는 `approval` 노드가 최대 하나만 있을 수 있고, 그 노드는 `bundle`로 게이트할 번들 하나를 가리켜야
한다. 승인 노드가 둘 이상이면 검증이 노드 id들과 이유를 들어 거부한다. 런의 활성 게이트는 그 하나뿐이다.

게이트 상태는 `pending | approved | rejected | skipped`다.

| 결정 | 게이트 | 승인 노드 | 의미 |
|---|---|---|---|
| `approve` | `approved` | `done` | 사람이 승인했다 |
| `reject` | `rejected` | `failed` | 사유와 함께 거절했다. 수정 후 `rerun`이 필요하다 |
| `skip` | `skipped` | `skipped` | 승인은 하지 않았지만 이 게이트를 건너뛰기로 결정했다 |

`skipped`는 `approved`와 다르다. 승인 노드는 절대 `done`으로 기록되지 않으므로 "승인받았다"고
거짓말하지 않는다. 대신 게이트 결정 자체는 끝났으므로 터미널 노드를 완료할 수 있다.

모든 결정은 영수증을 남긴다. 파일에는 누가(`by`), 언제(`at`), 무엇을(`decision`), 어느
런/번들/노드인지, 왜(`reason`, 거절/건너뜀)가 들어간다.

### MR 리뷰가 판단 화면이다

`dori sop gate show <run> <node>`는 게이트의 판단 근거(노드 체인과 노트, 번들 구성원과 영수증)를 출력한다.
`--post`를 주면 그 근거를 번들 MR에 코멘트로 게시하고, 같은 게이트를 다시 부르면 새 코멘트를 만들지 않고 그
코멘트를 갱신한다. `--post`가 없으면 gh/glab을 호출하지 않는다. 번들이 없거나 아직 MR이 없으면 게시를
건너뛰고 그 이유만 출력한다.

사람은 그 MR에서 승인하거나 변경 요청을 남긴다. `dori sop sync <run>`이 MR 리뷰 상태를 읽는다.

| MR 리뷰 | 게이트가 `pending`일 때 | 게이트가 이미 결정됐을 때 |
|---|---|---|
| 최신 승인 | `approve`와 같은 영수증, 승인 노드 `done` | `approved`면 `in sync`, 아니면 `MISMATCH`(exit 1) |
| 최신 변경 요청 | `reject`와 같은 영수증(사유=리뷰 본문) | `rejected`면 `in sync`, 아니면 `MISMATCH`(exit 1) |
| 결정 없음 | `pending` 유지 | `mr=no-decision`만 보고 |

작성자별 최신 리뷰 하나만 센다: 같은 사람이 변경 요청 뒤 승인하면 승인이다. `sync`가 쓴 영수증에는
`source: "mr"`과 읽은 MR 주소(`mr`)가 추가된다. `sync`는 이미 결정된 게이트를 조용히 덮어쓰지 않는다.
GitHub는 `gh`, GitLab은 `glab`을 쓰며 `--provider gh|glab`로 고른다(기본 `gh`).

### 정직성 규칙

승인 노드는 `dori sop step`으로 바꿀 수 없다. 게이트 명령만 바꾼다. 터미널 노드를 `done`으로
만들려면:

1. 런에 승인 게이트가 있어야 한다. 없으면 거부한다.
2. 게이트가 `pending`이면 거부한다("gate is pending").
3. 게이트가 `rejected`면 거부한다. 먼저 수정하고 `rerun`한 뒤 다시 결정해야 한다.

즉 게이트 결정 없이 마지막 노드를 완료해 런을 "끝난 것처럼" 만들 수 없다.

### 재실행

`dori sop rerun <run> <node>`는 그 노드와 모든 하위 노드(그 노드를 `needs`로 가진 노드, 전이적)를
`waiting`으로 되돌리고 시간/사유/영수증 연결을 지운다. 게이트 노드가 이 집합에 들어가면 게이트도
`pending`으로 돌아간다(이전 영수증 파일은 감사를 위해 디스크에 남는다). 게이트 이후 노드만 다시
돌리는 경우에는 게이트 결정을 유지한다.

## 4. CLI

```
dori sop list
dori sop show <id>
dori sop validate <id>
dori sop new <id> --title T [--from bundle|<id>]
dori sop run <id> --bundle <bundle-id>
dori sop step <run> <node> --state <state> [--note T]
dori sop gate list [--json]
dori sop gate show <run> <node> [--post] [--provider gh|glab]
dori sop gate approve <run> --by <name> [--note T]
dori sop gate reject <run> --by <name> --reason T
dori sop gate skip <run> --by <name> --reason T
dori sop sync <run> [--provider gh|glab] [--by NAME]
dori sop rerun <run> <node>
```

`new`의 기본 템플릿은 `bundle`(agent -> approval -> script)이고, 승인 노드의 `bundle`은 SOP id를 쓴다.
`--from`에 기존 SOP id를 주면 그 정의를 복사해 새 id로 만든다. `run`은 모든 노드를 `waiting`으로 두고
런 id를 출력한다. `gate list`는 `pending` 게이트만 보여주며 `--json`은 `{ "ok": true, "gates": [...] }`를
출력한다. `gate show`는 그 승인 노드가 가리키는 `bundle: <id>`와 번들 기록의 `repo`/`pr`을 출력하고,
`--post`가 있으면 판단 근거를 그 MR 코멘트로 게시한다. 번들 파일이 없으면 `bundle missing` 경고만 남기고
게시를 건너뛴다. `sync`는 MR 리뷰를 읽어 게이트를 대조한다. 리뷰가 작성자를 밝히지 않으면 `--by`로 보완한다.

예:

```sh
dori sop new bundle --title "Bundle flow"
dori sop run bundle --bundle b-42
dori sop step bundle-mbtx1 implement --state running
dori sop step bundle-mbtx1 implement --state done --note "3 files, tests green"
dori sop gate list
dori sop gate show bundle-mbtx1 approve --post
dori sop gate approve bundle-mbtx1 --by lee --note "diff reviewed"
dori sop sync bundle-mbtx1
dori sop step bundle-mbtx1 verify --state running
dori sop step bundle-mbtx1 verify --state done
```

## 5. 한계 (다음 단계)

- 파일 하나(`state/sop-runs.json`)를 읽고 고쳐 쓰는 단일 writer 모델이다. 동시 실행이 필요하면 잠금과
  이벤트 로그로 바꾼다.
- 노드를 실제로 실행하지 않는다. 실행 주체가 `step`으로 보고한다.
- 커스텀 웹 UI는 만들지 않는다. 게이트 판단은 MR 리뷰·체크 화면을 그대로 쓰고, dori는 근거 게시와 영수증
  기록만 한다. 보드 연동은 이번 범위가 아니다.
- `dori review` / `dori merge`는 바뀌지 않았다.
