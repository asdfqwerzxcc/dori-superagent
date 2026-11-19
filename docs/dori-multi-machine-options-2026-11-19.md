# 도리팀으로 다른 머신 자원 쓰기 — 조사 (2026-11-19)

요구: **계정 로그인 없이, 같은 LAN 안에서**, dori가 다른 머신의 CPU/RAM을 써서 작업하고 결과를 회수.

계정 기반 `omo remote`는 Lee 지시로 제외("로그인 안 하고 하고싶은데 같은 망에서만").

## 1. 확인된 사실 (실측)

- **herdr는 원격을 이미 지원한다.** `herdr --help`에 `herdr --machine <label-or-id> <command>`, `herdr --remote <ssh-target> [--session <name>]`, `herdr machine <add|list|status|reconnect|enable|disable|remove>`가 있다.
  - `herdr machine add` — "Prepare the remote Herdr server and save an SSH machine". 즉 SSH로 원격 herdr 서버를 준비하고 라벨을 저장.
  - `herdr --remote <host>` — 원격 세션을 로컬에 얇은 클라이언트로 붙이는 방식. 가이드: "SSH to the machine and run `herdr` there (works like tmux), or attach as a thin local client with `herdr --remote <host>`".
  - 현재 이 머신: `herdr machine list` → "No saved SSH machines" (아직 아무 머신도 등록 안 됨).
- **dori는 herdr를 얇게 감싼다.** `src/runtime/herdr/exec.ts`의 `HerdrCli.call()`은 `["--session", session, ...argv]`만 만든다 → `--machine`을 넣는 변경은 **2~3줄**.
- **dori의 레인은 로컬 파일시스템에 묶여 있다.** `startLane`이 로컬에서 worktree를 만들고 `--cwd`로 그 경로를 herdr에 넘긴다. 원격 pane에 로컬 경로를 넘기면 그 경로는 원격에 없다 → **원격 레인은 원격에서 worktree를 만들어야 함**.

## 2. 선택지 비교

|안 | 방식 | 계정 | 장점 | 단점 / 리스크 | 작업량 |
|---|---|---|---|---|---|
|**A. herdr `--machine`** | 리드 1개가 원격 herdr 서버에 pane을 만들어 레인 실행 | 불필요 | 한 화면에서 원격 pane 조작, 출력 회수 자연스러움 | **원격 worktree 생성·경로 매핑**을 dori가 추가로 구현해야 함(로컬 `git worktree` 코드가 원격 fs를 모름) | 중(2~3일) |
|**B. 원격 도리(팀원)** | 각 머신에 dori 상주, 리드는 ssh로 브리프만 전달, 결과는 `local/<machine>/<key>` 로 회수 | 불필요 | **오늘 바로 가능**. worktree·state가 각 머신 로컬이라 깨질 지점이 없음 | 리드가 원격 pane을 직접 못 봄(진행은 git/보고로) | 소(수동 0~30줄) |
|**C. omo remote** | `omo remote open <device>` | **필요** | ergonomics 최고 | Lee 제외 지시 | — |
|**D. 원격 MCP 도구** | 원격에 MCP 서버(run_build 등) 띄우고 ssh 터널로 호출 | 불필요 | 세밀한 원격 실행(빌드/테스트만 떼어내기) | 새 표면 추가, 여전히 파일 동기화 문제 | 중 |

## 3. 판정

- **1차는 B**: 계정 없이, 지금 구조 그대로, 깨질 지점 최소. "다른 머신 자원 쓰기"의 요구는 B로 충족된다(연산은 그 머신에서, 결과는 git으로).
- **A는 B를 써본 뒤**: 진짜 병목이 "원격 진행이 안 보인다"일 때만. 대신 원격 worktree 생성 로직이 선행 조건이라 작업량이 커진다.
- C는 계정 필요로 제외, D는 빌드/테스트만 원격으로 돌리는 특수 상황에만.

## 4. PoC (B안, 오늘 가능)

1. 대상 머신에 `git`, `bun`, 이 리포 + `bun install`, 그리고 `dori up`(리드/듀티).
2. LAN bare 허브: `git init --bare /srv/dori-hub.git`, 각 머신에 `git remote add hub …`.
3. 이 머신에서: 브리프 파일 작성 → `ssh <host> 'cd ~/.dori/src && bun src/cli.ts start <key> --brief /tmp/<key>.md'`.
4. 원격 완료 후 `git push hub local/<machine>/<key>` → 여기서 `git fetch hub` → 리드가 판단·착지.

## 5. 미확인 (UNVERIFIED)

- `herdr --machine`이 `tab create`/`pane read`까지 원격 서버로 라우팅하는지(SSH 대상이 없어 실행 검증 못 함 — 도움말 문구만 확인).
- 원격 herdr 서버 설치가 대상 머신에 무엇을 요구하는지(`machine add`가 자동 설치하는지 여부).
- Windows 대상의 경로 형식 차이(`/tmp` vs `%TEMP%`).
