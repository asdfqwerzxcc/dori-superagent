# 다른 머신에 dori 옮기기 (portable install)

회사 PC처럼 네트워크·계정·권한이 다른 머신에서 dori를 세우는 순서다. 레인·영수증·백로그 같은 **상태는 복사하지 않는다**. 코드와 설정만 옮기고, 상태는 git과 그 머신의 `DORI_HOME`이 새로 만든다. 마지막에 `dori doctor`로 이 머신이 준비됐는지 확인한다.

## 1. 준비물

| | Windows | Linux / macOS |
|---|---|---|
| 필수 | Git Bash, bun >= 1.4, git | git, bun >= 1.4 |
| 세션 런타임 | herdr(Doriterm) 또는 hc(herdr-core) | herdr 또는 hc |
| 원격 연결 | OpenSSH 클라이언트 | OpenSSH 클라이언트 |
| SCM(선택) | gh(GitHub) 또는 glab(GitLab) | gh 또는 glab |
| 에이전트(필수) | omo(+ senpi 엔진) | omo(+ senpi 엔진) |

- bun은 <https://bun.sh>에서 설치한다. dori는 bun 1.4.4에서 개발·검증했고 `dori doctor`는 1.4 미만을 FAIL로 본다.
- 세션 런타임은 둘 중 하나면 된다. Doriterm은 `curl -fsSL https://get.doriterm.com | sh -s -- --no-pair`, herdr-core는 <https://releases.herdr.dev/core/install.sh>로 설치한다. 이미 Doriterm이 있으면 두 번째 host를 설치하지 않는다.
- Windows에서는 Git Bash에서 실행한다. `bun src/cli.ts ...`는 PowerShell에서도 되지만, 이 문서의 셸 예시는 Git Bash 기준이다.
- Node는 선택이다. dori 자체는 bun으로 돌고, 일부 도구만 Node를 쓴다.
- gh/glab과 ssh는 없어도 dori의 핵심 명령은 돈다. `dori doctor`가 WARN으로 남긴다.

## 2. 코드 가져오기 (3가지 중 하나)

목적지는 기본적으로 `~/.dori/src`다(`install.sh`의 `DORI_SRC` 기본값). 어느 방법이든 끝나면 의존성과 CLI 링크를 만든다.

### 2.1 사내 GitLab 미러

```bash
git clone <사내 GitLab>/dori-superagent.git ~/.dori/src
cd ~/.dori/src
bun install
(cd skills/dori-mode/scripts && bun install && bun link)
```

사내 미러가 읽기 전용이면 개인 fork를 별도 remote로 두고 작업한다. `dori` 명령은 `skills/dori-mode/scripts`의 `bun link`가 PATH에 올린다.

### 2.2 `git bundle` (네트워크 없이)

인터넷이 막혔거나 저장소를 USB로 옮길 때 쓴다. 원본 머신에서:

```bash
git clone --mirror <dori 저장소 URL> dori-mirror.git
cd dori-mirror.git
git bundle create ../dori.bundle --all
```

대상 머신에서:

```bash
git bundle verify dori.bundle
git clone dori.bundle ~/.dori/src
cd ~/.dori/src
git remote set-url origin <사내 미러 또는 공개 GitHub URL>
bun install
(cd skills/dori-mode/scripts && bun install && bun link)
```

번들은 커밋과 ref만 담는다. `node_modules`, `~/.dori`, 모델 자격증명은 담기지 않으므로 각각 새로 만든다.

### 2.3 공개 GitHub

가장 빠른 길이다. Git Bash에서:

```bash
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

이 스크립트는 `~/.dori/src` 클론, `~/.agents/skills/dori-mode` 링크, `dori` CLI 링크, `~/.dori/config.json` 예제 복사를 한 번에 한다. Doriterm이 이미 있으면 건드리지 않고, 건너뛰려면 `DORI_NO_DORITERM=1`을 준다.

### 공통 마무리

```bash
cd ~/.dori/src && bun install
(cd skills/dori-mode/scripts && bun install && bun link)
mkdir -p ~/.dori
[ -f ~/.dori/config.json ] || cp skills/dori-mode/references/config.example.json ~/.dori/config.json
dori --help
```

`config.json`에서 최소한 `runtime`(herdr/hc)을 정한다. dori-mode 스킬을 같이 쓸 거면 `leadPane`, `laneWorkspace`, `defaultCwd`도 채운다.

## 3. `DORI_HOME` 분리

`DORI_HOME`은 dori의 **상태 루트 전체**다: `lanes/`, `inbox/`, `briefs/`, `receipts/`, `backlog/`, `worktrees/`, `state/`. 기본값은 `~/.dori`다.

프로젝트마다 도리를 따로 띄울 때는 그 프로젝트 안에 홈을 둔다.

```bash
export DORI_HOME="$HOME/proj-x/.dori"
dori doctor
```

PowerShell:

```powershell
$env:DORI_HOME = "$HOME\proj-x\.dori"
dori doctor
```

- 별도 `DORI_HOME`은 별도 상태다. 레인·인박스·영수증이 메인과 섞이지 않는다.
- 두 홈 사이에 `lanes/`, `inbox/`, `receipts/`, `state/`를 **복사하지 않는다**. 복사한 레인은 이미 닫힌 pane을 가리키고, 영수증은 다른 커밋을 가리킨다. 결과의 진실원은 git 브랜치와 MR/PR이다.
- 워크트리를 다른 디스크에 두려면 `DORI_WORKTREES_DIR`를 쓴다. 기본값은 `$DORI_HOME/worktrees`다.
- `$DORI_HOME/config.json`에는 자격증명이 없다. 머신마다 예제에서 새로 만들어도 된다.

## 4. 게이트웨이 끄기 (회사 PC)

Discord 게이트웨이는 버전 관리 대상이 아닌 host 코드 `~/.dori/bin/discord-gateway.ts`다. 새 클론에는 이 파일이 없으므로, 복사하지 않으면 게이트웨이는 뜨지 않는다.

- 토큰을 두지 않는다: `DORI_DISCORD_TOKEN` 환경변수와 `$DORI_HOME/discord.token` 파일을 만들지 않는다.
- Discord 쪽 플러그인을 끈다:

```bash
dori plugin disable gateway-catchup
dori plugin disable silence-check
dori plugin list
```

플러그인 레지스트리는 `src/plugins/registry.ts`에 손으로 적힌 목록이다. 거기에 import되지 않은 파일은 빌드·테스트·실행 어디에도 존재하지 않는다. 즉 "플러그인 미등록"은 곧 "동작하지 않음"이다.

- 슈퍼바이저의 코어 자식에는 `discord-gateway`가 항상 들어 있다. `bin/discord-gateway.ts`가 없는 홈에서 `dori up`/`dori restart`를 돌리면 그 자식이 즉시 종료되고 5초마다 재시도하며 `state/supervisor.log`에 줄을 남긴다. 슈퍼바이저 자체를 안 돌리려면 `dori up`을 쓰지 말고 레인만 `dori start`로 연다. 슈퍼바이저를 쓰는 홈이라면 `ensure-up` 플러그인이 `dori up`을 자동 실행할 수 있으므로 같이 끈다:

```bash
dori plugin disable ensure-up
```

- 외부 네트워크를 아예 쓰지 않을 머신:
  - `dori plugin disable update-check` (하루 한 번 git/패키지 업데이트 확인)
  - `DORI_TELEMETRY=0` 또는 `DO_NOT_TRACK=1` (익명 사용 카운트)
- 포트 8084(게이트웨이)와 7799(향후 페어링)는 비워 둔다. 다른 dori나 게이트웨이가 잡고 있으면 `dori doctor`가 WARN으로 알린다.

## 5. 모델 자격증명은 머신 로컬

- omo 설정은 `~/.omo/omo.json`이다. 카테고리 모델(`categories.<name>.model` 또는 `.models`)과 에이전트 모델이 여기에 있고, provider 자격증명도 여기나 OS 키체인에 있을 수 있다.
- `~/.omo/omo.json`을 머신 사이로 복사하거나 git에 커밋하지 않는다. 회사 PC에서는 그 머신에서 `omo login`을 다시 하고, 사내 게이트웨이/키로 provider를 재설정한다.
- dori는 자격증명 값을 읽거나 출력하지 않는다. `dori doctor`는 credential 모양의 키가 **있으면** "machine-local" WARN만 남기고 값을 보여주지 않는다.
- 카테고리 모델이 하나도 없으면 `dori doctor`가 WARN으로 남긴다. dori가 쓰는 카테고리(`quick`, `deep-low` 등)에 최소 하나를 지정한다.
- `$DORI_HOME/config.json`은 모델 자격증명을 담지 않는다. `runtime`, `leadPane`, `laneWorkspace`, `defaultCwd` 같은 dori/스킬 설정만 있다.

## 6. 회사 PC 권장 역할: 프로젝트 도리 전용

- **메인 도리**는 사람당 하나다. `~/.dori`를 쓰고 백로그·게이트·메신저를 소유한다.
- **회사 PC**는 그 프로젝트의 레인·워크트리·리뷰 영수증만 소유하는 **프로젝트 도리**로 쓴다. `DORI_HOME=~/proj-x/.dori`로 분리하고, 두 번째 메인/백로그를 만들지 않는다.
- 연결은 지금은 ssh다. 메인에서:

```bash
dori remote add company-pc --ssh user@company-pc --repo ~/.dori/src --os linux
dori remote start company-pc fix-login --brief briefs/fix-login.md
```

Windows 대상이면 `--os windows`, 저장소 경로는 그 머신 기준으로 준다. `dori remote`는 `BatchMode=yes`로 ssh를 부르므로 키 인증이 먼저다.

- `dori link`(8자 코드 + 지문 페어링)는 아직 이 체크아웃에 없다. S1 계획으로만 존재하므로, 구현 전까지는 위 ssh 경로를 쓴다.
- 결과는 상태 파일이 아니라 git으로 회수한다. 레인 브랜치를 `local/<machine>/<key>`로 밀거나 사내 GitLab MR로 올린다. `dori done`이 메인에서 레인을 랜딩하는 흐름은 같은 저장소를 공유할 때만 성립한다.

## 7. 점검: `dori doctor`

```bash
dori doctor              # 오프라인, PASS/WARN/FAIL 표
dori doctor --json       # 같은 결과를 JSON으로
dori doctor --online     # gh/glab 인증까지 확인
```

- 기본 점검은 **오프라인**이다. 점검 probe는 원격 서비스에 접속하지 않는다. `--online`일 때만 `gh auth status`/`glab auth status`를 부른다.
- dori CLI 자체의 익명 사용 카운트(텔레메트리)는 점검과 별개다. 완전히 네트워크를 끊으려면 `DORI_TELEMETRY=0`을 준다.
- FAIL이 하나라도 있으면 종료코드 1, 아니면 0이다. WARN은 0이다.
- 각 항목은 주입 가능한 probe다. 테스트는 실제 PATH·파일·포트를 보지 않고, 오프라인 실행이 인증 명령을 부르지 않는 것도 확인한다.

점검 항목과 대응:

`dori doctor`는 `DORI_HOME`을 만들거나 고치지 않는다. 없는 디렉터리는 WARN으로만 남고, 실제 생성은 `dori up`이나 `dori start`처럼 상태를 쓰는 명령이 한다. 그래서 홈이 깨져 있어도 표를 끝까지 볼 수 있다.

| 항목 | FAIL / WARN | 대응 |
|---|---|---|
| `runtime` | FAIL: bun 없음 또는 1.4 미만 | bun 설치, `bun upgrade` |
| `git` | FAIL: git 없음 / WARN: 리포 아님, dirty | git 설치, 체크아웃 안에서 실행, 커밋 또는 stash |
| `dori home` | FAIL: 경로가 디렉터리 아님·쓰기 불가·`config.json` JSON 오류 / WARN: `state/` 없음 | `DORI_HOME` 권한·경로 수정, JSON 수정 또는 삭제, `dori up` 또는 레인 시작을 한 번 실행 |
| `session runtime` | FAIL: herdr·hc 둘 다 없음 / WARN: `herdr status` 실패 | 런타임 설치, `config.json`의 `runtime` 설정, herdr 기동 |
| `agent engine` | FAIL: omo·senpi 없음, `omo.json` 파싱 실패 / WARN: 카테고리 모델 0개, credential 존재 | omo 설치, `omo login`, `categories.*.model` 지정, credential은 그 머신에만 둠 |
| `scm tools` | WARN: gh/glab 없음 또는 `--online` 인증 실패 | 필요한 도구 설치, `gh auth login` / `glab auth login` |
| `ssh` | WARN: ssh 없음, `~/.ssh` 없음 | OpenSSH 설치, `~/.ssh`와 키 준비 |
| `ports` | WARN: 8084/7799 사용 중 또는 확인 불가 | 점유 프로세스 종료 또는 포트 변경 |
| `disk / memory` | WARN: 여유 디스크 < 2 GiB, 총 메모리 < 8 GiB | 공간 확보, 메모리 증설 또는 동시 세션 수 축소 |

`--json` 스키마 (아래는 항목 하나만 남긴 축약 예시다. 실제 `checks`에는 9개가 모두 들어간다):

```json
{
  "schemaVersion": 1,
  "online": false,
  "ok": false,
  "checks": [
    {
      "id": "runtime",
      "title": "runtime",
      "status": "FAIL",
      "detail": "bun is not on PATH; node 22.0.0 (optional)",
      "hint": "install bun >= 1.4: https://bun.sh"
    }
  ],
  "summary": { "pass": 0, "warn": 0, "fail": 1 }
}
```

- `checks`는 `runtime`, `git`, `home`, `session`, `agent`, `scm`, `ssh`, `ports`, `resources` 순서다.
- `status`는 `PASS`, `WARN`, `FAIL` 중 하나다. `hint`는 없을 수 있다.
- `ok`는 FAIL이 0일 때 true다. `summary`는 상태별 개수다.
- `detail`에는 경로·버전·개수만 들어간다. 토큰·키 값은 절대 들어가지 않는다.

## 8. 회사 PC 체크리스트

- [ ] `bun --version`이 1.4 이상
- [ ] `git --version`; 프로젝트 체크아웃이 리포이고 원하는 remote가 있음
- [ ] `herdr --version` 또는 `hc --version`; `runtime` 설정
- [ ] `omo --version`; `omo login`; 카테고리 모델 최소 1개
- [ ] `DORI_HOME`을 프로젝트별로 분리
- [ ] `DORI_DISCORD_TOKEN`/`discord.token` 없음; Discord 플러그인 비활성
- [ ] (선택) `gh auth status` 또는 `glab auth status` 통과
- [ ] `dori doctor`가 FAIL 0으로 끝남. 남은 WARN은 이유를 알고 있음
- [ ] `dori doctor --json` 결과를 기록해 두면 다음 머신과 비교하기 쉽다
