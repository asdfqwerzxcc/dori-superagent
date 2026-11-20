# dori board — Vercel Board의 로컬 이식 (v1)

Vercel Board의 **태스크/스레드 모델**을 계정과 호스팅 없이 dori 홈 안에서 쓸 수 있게 옮긴 것이다. 서비스에 붙지 않고,
`$DORI_HOME/state/board.jsonl` 한 파일만으로 동작한다. Slack 동기화, 원격 서버, 미국 데이터 평면은 포함하지 않는다.

## 모델

### 태스크 = 스레드

태스크는 스레드다. 태스크 id가 곧 스레드 id이고, 루트 메시지가 태스크 제목이며, 답장(reply)이 작업 로그다.

```bash
dori board task create --title "CVE-123 수정"
# TASK t_1a2b3c4d5e6f7a8b ready

dori board reply t_1a2b3c4d5e6f7a8b --text "패치 적용, 테스트 실행 중"
dori board read t_1a2b3c4d5e6f7a8b
# THREAD t_1a2b3c4d5e6f7a8b #general
# TASK t_1a2b3c4d5e6f7a8b ready epoch=0
# m_... 2026-11-20T... CVE-123 수정
# m_... 2026-11-20T... 패치 적용, 테스트 실행 중
```

`post --thread new`로 만든 일반 스레드도 같은 저장소와 `read`/`reply`를 쓴다. 채널은 경로 문자열(`work/checkout`)이고
기본값은 `general`이다. `--channel`은 새 스레드를 만들 때만 적용된다.

### 상태

| 상태 | 의미 |
| --- | --- |
| `waiting` | `needs` 중 아직 `completed`가 아닌 태스크가 있다 |
| `ready` | 클레임할 수 있다 |
| `claimed` | 리스가 살아 있는 동안 한 워커가 잡고 있다 |
| `blocked` | 사람의 입력/승인을 기다린다. 리스는 끝난다 |
| `completed` | 결과 텍스트와 함께 끝났다 |
| `failed` | 워커가 포기했다. 사유가 남는다 |
| `canceled` | 소유자가 취소했다. 사유가 남는다 |

`reopened`는 머무는 상태가 아니라 전이 이름이다. `failed`/`canceled`를 `reopen`하면 `ready`가 되고, 선행이 아직
끝나지 않았으면 `waiting`이 된다.

### 전이표

전이 규칙은 `src/board-types.ts`의 `TRANSITIONS` 한 곳에만 있다. 표에 없는 전이는 `Refusal`이다.

| 동작 | 허용되는 현재 상태 |
| --- | --- |
| `claim` | `ready` |
| `renew` | `claimed` |
| `release` | `claimed` |
| `complete` | `claimed` |
| `fail` | `claimed` |
| `block` | `claimed` |
| `unblock` | `blocked` |
| `cancel` | `waiting`, `ready`, `claimed`, `blocked` |
| `reopen` | `failed`, `canceled` |
| `needs` | `waiting`, `ready`, `blocked` |

`cancel`과 `reopen`은 상태기계에 있는 `canceled`/`reopened`를 실제로 도달 가능하게 하는 명령이라 v1에 넣었다.
`cancel`은 소유자 동작이라 토큰이 필요 없고, 잡고 있던 리스도 끝낸다. `unblock`도 소유자 동작이다.

## 리스, 토큰, epoch

클레임은 리스다.

- 기본 리스는 **300초(5분)**, 최대 300초다. `--lease 60`처럼 1~300초 사이 정수로 줄일 수 있다.
- `task claim`은 성공할 때만 토큰을 한 번 출력한다. 이후 `renew`, `release`, `complete`, `fail`, `block`은 그 토큰을
  요구한다.
- `renew`는 지금부터 원래 리스 길이만큼 연장한다.
- 리스가 만료되면 태스크는 다시 `ready`이고, 만료된 클레임의 `renew`/`complete`/`fail`/`block`은 `claim_lost`로
  거부된다.
- `release`, `block`, `cancel`, `complete`, `fail`도 그 클레임을 끝낸다. 끝난 클레임의 토큰은 `claim_lost`다.
- 두 워커가 같은 `ready` 태스크를 클레임하면 하나만 성공하고 다른 쪽은 `task_claimed`를 받는다.
  `claim --ready`는 가장 오래된 `ready` 태스크를 잡으며, 없으면 `nothing_ready`다.
- 클레임마다 태스크의 `epoch`가 1씩 오른다. 토큰이 우연히 같아도 epoch가 다르면 낡은 워커는 정산할 수 없다.
  재클레임된 태스크를 낡은 토큰으로 완료하려 하면 `claim_lost`다.

`--for <worker>`는 클레임/완료 작성자를 감사용으로 남긴다. 토큰은 `read`나 `tasks --json`에 나오지 않는다.
CLI는 클레임을 수행한 호출에만 토큰을 출력한다.

로컬 보드의 변경은 `$DORI_HOME/state/board.lock`으로 직렬화한다. 다른 프로세스가 잠깐 잡고 있으면 최대 약 200ms
기다린다. 그래도 잡히지 않으면 `board_busy`로 거부한다(재시도하면 된다). 락은 pid와 호스트를 기록하므로 죽은
프로세스의 락은 즉시 회수한다.

## 의존성 DAG (`needs`)

- 태스크는 `--needs <id>`로 선행 태스크를 가질 수 있다. 여러 개면 모두 `completed`여야 `ready`가 된다.
- 선행이 `failed` 또는 `canceled`면 후속은 `waiting`에 머문다. 선행을 `reopen`해도 후속은 즉시 풀리지 않고,
  선행이 다시 `completed`가 되어야 풀린다.
- 선행이 `completed`가 되면 그 선행만 기다리던 후속이 `ready`가 된다. 연쇄는 다음 태스크가 완료될 때 이어진다.
- 자기 자신, 없는 태스크, 사이클을 만드는 `needs`는 `invalid_needs`로 거부한다.
- `task needs <id> --add <other>...`와 `--remove <other>...`는 한 번에 하나씩만 받는다. `claimed`이거나 끝난
  태스크의 `needs`는 바꿀 수 없다. `blocked` 태스크의 `needs`는 바꿀 수 있고, `unblock`할 때 다시 계산된다.

## 결과

`complete <id> --token <token> --result <text|@file>`의 결과는 자유 텍스트다. 브랜치, sha, 테스트 결과를 그대로
적으면 된다. `@file`은 파일 내용을 읽는다.

v1에는 결과 JSON 스키마, 예약 라벨, 클라이언트 멱등키를 넣지 않았다. 대신 이벤트 로그 자체가 멱등이다. 같은
이벤트 id의 줄이 두 번 있어도 폴드에서 한 번만 적용된다. 클라이언트가 같은 명령을 두 번 보내는 경우는 상태기계가
막는다(두 번째 `claim`은 `task_claimed`, 끝난 클레임의 정산은 `claim_lost`).

## 저장

- **경로**: `$DORI_HOME/state/board.jsonl`
- **형식**: 한 줄에 이벤트 하나. `thread.created`, `message.created`, `task.created`, `task.claimed`,
  `task.renewed`, `task.released`, `task.completed`, `task.failed`, `task.blocked`, `task.unblocked`,
  `task.canceled`, `task.reopened`, `task.needs`, `board.snapshot`.
- **읽기**: 전체 로그를 폴드해 현재 보드를 만든다. 각 이벤트에는 `v`, `id`, `at`, `kind`가 있고, 같은 `id`는
  한 번만 적용한다.
- **append-only**: 일반 명령은 로그 끝에만 쓴다. 기존 줄을 고치지 않는다.
- **압축**: 자동 압축은 v1에 없다. 로그가 길어지면 `dori board compact`를 명시적으로 실행해 현재 상태를 한 줄
  `board.snapshot`으로 접는다. 압축 후에도 폴드 결과는 같다. 스냅샷 이후 이벤트는 그 위에 다시 붙는다.
- **epoch 파일 없음**: 태스크별 `epoch`는 클레임 이벤트에서 계산되므로 `board.epoch` 파일을 따로 두지 않는다.
- **시간**: 모든 명령은 `Deps.now`를 주입받는다. 테스트는 시계를 앞으로 옮길 뿐 잠들지 않는다.
- **손상**: JSON이 아닌 줄, 버전이 다른 줄, 알 수 없는 이벤트 종류는 `board_corrupt`로 읽기를 거부한다. 마지막
  줄이 개행 없이 끝나면 동시 append의 일부로 보고 무시한다.

이벤트 예시:

```json
{"v":1,"id":"e_...","at":1795187042000,"kind":"task.claimed","task":"t_...","token":"c_...","epoch":1,"leaseSeconds":300,"leaseUntil":1795187342000,"worker":"worker-a"}
```

## CLI

모든 명령에 `--json`을 붙일 수 있다. 성공은 `{ "ok": true, ... }`, 실패는
`{ "ok": false, "reason": "<code>", "error": "<message>" }`이고 종료 코드는 1이다. `--json`이 없으면 실패는
`reason: message` 형태로 stderr에 출력되고 종료 코드는 2다(기존 dori 관례).

### 스레드

```bash
dori board post --thread new --channel work/checkout --text "배포가 초록불" --label kind=note
# POSTED t_... m_...

dori board reply t_... --text "확인"
# REPLIED t_... m_...

dori board read t_... --json
# {"ok":true,"thread":{"id":"t_...","channel":"work/checkout","createdAt":...,"messages":[...]}}
```

`post --thread <id>`는 기존 스레드에 메시지를 덧붙인다. 없는 스레드는 `thread_not_found`다.

### 태스크

```bash
dori board task create --title "CVE-123 수정" --data branch=fix/cve --data sha=a1b2c3
dori board task create --title "수정 리뷰" --needs t_...   # 선행이 끝날 때까지 waiting
dori board tasks --state ready
dori board tasks --state done --json

dori board task claim --ready --lease 300 --for worker-a
# CLAIMED t_... epoch=1 token=c_... lease_until=2026-11-20T...

dori board task claim t_... --json
dori board task renew t_... --token c_...
dori board task release t_... --token c_... --reason "다른 작업으로 전환"
dori board task complete t_... --token c_... --result "fixed in a1b2c3, tests pass"
dori board task complete t_... --token c_... --result @state/result.txt
dori board task fail t_... --token c_... --reason "재현 실패"
dori board task block t_... --token c_... --reason "prod 배포 승인?" --kind awaiting_approval
dori board task unblock t_...
dori board task cancel t_... --reason "중복"
dori board task reopen t_...
dori board task needs t_... --add t_...
dori board task needs t_... --remove t_...
dori board compact
# COMPACTED 42 events -> 7 threads, 5 tasks
```

`tasks`의 기본 목록은 끝나지 않은 태스크(`waiting`, `ready`, `claimed`, `blocked`)다. `--state done`은
`completed`/`failed`/`canceled`를 보여준다. 정렬은 생성 시각, 같으면 id 순서다.

### 오류 코드

| `reason` | 의미 |
| --- | --- |
| `task_not_found`, `thread_not_found` | id가 없다 |
| `nothing_ready` | `claim --ready`가 잡을 태스크를 찾지 못했다 |
| `task_claimed` | 다른 클레임이 살아 있다 |
| `task_waiting` | 선행이 아직 끝나지 않았다 |
| `task_blocked` | 사람을 기다리는 중이다 |
| `task_finished` | 끝난 태스크를 바꾸려 했다 |
| `claim_lost` | 토큰이 낡았거나 리스가 끝났다 |
| `invalid_needs` | 없는 선행, 자기 자신, 사이클 |
| `board_busy` | 다른 프로세스가 보드 락을 잡고 있다 |
| `board_corrupt` | 로그를 폴드할 수 없다 |
| `bad_request` | 인자/값이 잘못됐다 |

## Vercel Board에서 이식한 부분

- 태스크 = 스레드, 루트 = 지시, 답장 = 작업 로그.
- `waiting → ready → claimed → blocked → completed | failed | canceled` 상태기계와 `reopen` 전이.
- 5분 리스, 갱신, 만료 시 재클레임, 경쟁 클레임의 단일 승자(`task_claimed`), 클레임 종료 후 `claim_lost`.
- 클레임 epoch/토큰으로 낡은 워커의 정산 차단.
- `needs` DAG: 선행 완료 시에만 ready, 실패/취소 선행은 후속을 풀지 않음, 사이클 거부.
- 자유 텍스트 결과(`complete <result>`).
- append-only 이벤트 로그와 폴드.

## 이식하지 않은 부분 (v1 경계)

- **Vercel 호스팅/계정/API**: 서비스에 접속하지 않는다. 로컬 파일이 유일한 저장소다.
- **미국 데이터 평면**: Vercel의 데이터 평면, 리전, 팀/보드 접근 제어를 쓰지 않는다.
- **Slack/GitHub/Linear 동기화**, 첨부 파일, 스케줄, grants, schema, watcher, `wait`, `tail`, 라벨 라우팅.
- **UI/보드 화면**.
- **태스크 소유권/권한 모델**: 로컬 사용자 한 명이 모든 태스크를 소유한다. `unblock`/`cancel`/`reopen`/`needs`는
  소유자 동작으로 두고 별도 토큰을 요구하지 않는다.
- **클라이언트 멱등키**: `--idempotency-key`는 v1에 없다. 같은 이벤트 줄의 재적용은 폴드가 막는다.
- **자동 압축**: 없음. `dori board compact`만 수동 유지보수 경로다.
- **원격 서버/다중 호스트**: 로그와 락은 한 머신의 `$DORI_HOME` 안에 있다. 다른 머신과 공유하려면 별도 작업이 필요하다.

## 테스트

```bash
bun test ./test/board.test.ts
```

11개 테스트가 전이표 전수(허용/거부), 스레드/결과, 리스 만료 후 재클레임, 경쟁 클레임, epoch로 낡은 토큰 거부,
`needs` 게이트와 실패/취소 선행, 사이클 거부, block/unblock/release/cancel/reopen, append-only 폴드, 이벤트 재적용
멱등성, compact 후 동일 상태, CLI 토큰 노출/비노출과 `@file` 결과를 확인한다.

셸 실증은 `state/board-evidence.txt`에 있다. 태스크 두 개를 만들고 `needs`를 건 뒤, 선행을 클레임/완료하고 후속이
`ready`가 되는 것과 `tasks --json`을 캡처했다.
