# dori remote — 같은 LAN의 다른 머신에서 레인 실행하기

계정 로그인, 중계 서버, 클라우드 없이 **평범한 ssh**로 같은 LAN의 다른 머신 CPU/RAM을 쓴다. 리드는 브리프만 넘기고,
실제 작업(worktree, omo 세션, 테스트)은 그 머신에서 돌아간다. 결과는 git으로 회수한다.

## 준비물

대상 머신(예: `box2`)에 다음이 있어야 한다.

- `sshd`가 떠 있고 리드 머신에서 접속된다. **키 인증**을 설정한다(`ssh-copy-id user@box2`). `dori remote`는
  `BatchMode=yes`로 ssh를 부르므로 비밀번호를 묻지 않는다. 비밀번호만 설정돼 있으면 즉시 실패한다.
- `git`, `bun`, 이 리포의 체크아웃(`bun install` 완료). 원격에서 `bun src/cli.ts start`가 그대로 동작해야 하므로
  herdr(또는 hc)와 omo, `DORI_HOME`도 리드와 같은 방식으로 준비한다.
- 두 머신이 같은 LAN에 있고, 리드에서 `ssh user@box2`가 프롬프트 없이 붙는다.

선택: 결과 회수용 bare 허브. 리드 머신에 만든다.

```sh
git init --bare /srv/dori-hub.git
# 각 머신에서:
git remote add hub <lead-host>:/srv/dori-hub.git
```

## 설정

`$DORI_HOME/config/remotes.json`:

```json
{
  "machines": [
    { "name": "box2", "ssh": "user@192.168.0.12", "repo": "~/.dori/src", "os": "linux" },
    { "name": "winbox", "ssh": "lee@192.168.0.20", "repo": "C:\\work\\dori", "os": "windows" }
  ]
}
```

- `repo`: 그 머신에서 이 리포가 있는 경로다. `bun src/cli.ts`가 실행되는 곳.
- `os`: `linux`(기본) 또는 `windows`.
- `name`은 `[A-Za-z0-9][A-Za-z0-9._-]*`만 쓴다. `ssh`는 `user@host` 형태여야 하고 공백이나 선행 `-`를 쓸 수 없다
  (ssh 옵션 주입 방지).

CLI로 추가하면 파일을 직접 고칠 필요가 없다. `add`는 설정만 쓰고 접속을 확인하지 않는다(외부 호출 없음).

```sh
dori remote add box2 --ssh user@192.168.0.12 --repo ~/.dori/src --os linux
dori remote list
```

`list`는 설정된 머신과 최근 시작 기록(최대 10개)을 출력한다. 시작 기록은
`$DORI_HOME/state/remotes.json`의 표에 쌓인다.

```json
{ "rows": [{ "machine": "box2", "key": "fix-login", "started_at": 1760000000000, "ssh": "user@192.168.0.12", "repo": "~/.dori/src" }] }
```

## 실행

```sh
dori remote start box2 fix-login --brief briefs/fix-login.md
```

순서:

1. 브리프를 `scp`로 원격 임시경로에 복사한다. 리눅스는 `/tmp/dori-<key>.md`, 윈도우는
   `%USERPROFILE%\AppData\Local\Temp\dori-<key>.md`에 해당하는 파일이다.
2. `ssh user@192.168.0.12 'cd ~/.dori/src && bun src/cli.ts start fix-login --brief /tmp/dori-fix-login.md'`를 실행한다.
   원격의 `dori start`가 그 머신에서 worktree와 세션을 연다(키는 로컬과 같은 `fix-login`).
3. 원격 stdout/stderr를 그대로 보여준다. 성공하면 `$DORI_HOME/state/remotes.json`에 행을 하나 기록한다.
4. 실패하면 scp 또는 ssh의 stderr와 종료 코드를 그대로 담아 멈춘다. 이때는 표에 행을 쓰지 않는다.

ssh/scp 옵션: `-o BatchMode=yes -o ConnectTimeout=10`. 추가로 scp는 120초, ssh는 300초의 하드 타임아웃이 있어
연결 후 멈춘 프로세스를 죽인다.

### 명령만 확인하기

```sh
dori remote start box2 fix-login --brief briefs/fix-login.md --dry-run
```

`scp`/`ssh`를 부르지 않고, 브리프 존재 여부도 확인하지 않으며, 표에도 쓰지 않는다. 출력된 두 줄이 실제로 실행될
argv다. SSH 대상이 없을 때 이것으로 경로/인용을 검증한다.

## 결과 회수

원격 레인의 커밋은 그 머신의 `lane/<key>` 브랜치에 있다. 원격에서 허브로 밀고, 리드에서 회수한다.

```sh
# 원격 머신에서
git push hub lane/fix-login:local/box2/fix-login

# 리드 머신에서
git fetch hub 'refs/heads/local/*:refs/remotes/<machine>/*'
git log --oneline refs/remotes/box2/fix-login
```

`<machine>`은 위 예에서 `box2`다. 회수한 브랜치는 리드가 검토한 뒤 평소처럼 main에 착지시킨다. 이 명령은 원격
레인이 끝난 뒤에만 의미가 있다. 원격 레인의 진행 상황은 원격 `dori`의 보고(리드 세션이 같은 홈을 쓰는 경우) 또는
git으로만 보인다.

## 보안 주의

- **LAN 전용**이다. ssh 포트를 공인 IP에 노출하지 않는다. 필요하면 방화벽에서 LAN 대역만 허용한다.
- 계정·중계·클라우드 요소는 없다. 인증은 ssh 키 하나뿐이므로 키를 머신별로 관리하고, 잃어버리면 `authorized_keys`에서
  지운다.
- `BatchMode=yes`는 비밀번호 프롬프트를 막는다. 자동화가 비밀번호를 입력하는 경로는 없다.
- 브리프는 원격 임시경로에 복사된다. 민감한 내용이면 `/tmp` 대신 접근이 제한된 경로를 쓰도록 대상 머신을 설정한다.

## 한계

- 원격 pane을 로컬에서 직접 보지 못한다. 진행은 보고와 git으로 확인한다.
- 원격 머신에 별도 `DORI_HOME`이 있으면 그쪽 `dori` 상태(레인·영수증)는 로컬과 다르다. 결과의 단일 출처는 git이다.
- 윈도우 대상에는 `PowerShell`이 있어야 한다(윈도우 기본 포함). 원격 명령은 `powershell -NoProfile -EncodedCommand <base64>` 한 줄로 보내
  인용부호·`&&`·`%VAR%`가 셸에 전혀 해석되지 않는다. 그래서 sshd 기본 셸이 `cmd`든 `PowerShell`이든 동일하게 동작한다.
  (`cmd /c "cd /d ""…"" && …"` 형태는 cmd 로그인 셸에서 중복 인용이 깨지고, PowerShell 5.1은 `&&`를 지원하지 않는다.)
- 브리프는 `temp` 경로(기본 `C:\Users\Public\dori`, `--temp`로 변경)에 쓰이고, 원격 명령은 `--cwd <repo>`로 리포를 지정한다.
  `%USERPROFILE%` 같은 셸 변수는 쓰지 않는다.
- 구성 예시에 `temp`를 넣으려면 `dori remote add winbox --ssh … --repo … --os windows --temp 'D:\tmp\dori'`.
