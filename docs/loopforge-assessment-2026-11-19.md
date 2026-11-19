# LoopForge 조사 (Tencent, MIT) — 2026-11-19

조사 대상: https://github.com/Tencent/LoopForge · 클론 HEAD `4175c9629a6557bd616fb17c036a8afd3cef1199` (2026-11-19, `feat(chat): refresh workspace repository context on demand (#1096)`)
저장소 성격: MIT, Go 백엔드 + React(web/chatbot), MySQL, Docker 샌드박스. 2026-07-28 생성, ★약 4.0k.
아래 모든 주장은 클론 소스의 `파일:줄` 인용이다. 인용이 없는 항목은 **UNVERIFIED**로 표시했다.

## 1. 한 줄 결론

**"사내 GitLab에서 충분히 쓸 수 있다. 단 MR 생성은 `glab` 스크립트로 우리가 붙이고, 플랫폼은 그 MR을 추적·동기화한다."**
즉 앞서 내가 제안한 'SOP 스크립트 + glab' 경로가 옳았고, 추가로 **MR 상태 추적까지 플랫폼이 해준다**는 게 실측으로 확인됐다.

## 2. 무엇인가 (구조)

- 진입점: `cmd/agentflow`(메인 서버), `cmd/agentflow-runner`(실행기), `cmd/agentflow-mcp`·`agentflow-gate-mcp`(MCP), `cmd/loopforge-account`.
- `internal/engine` = 워크플로(SOP) 실행 엔진, `internal/tracker` = 이슈/MR 동기화, `internal/runtime` = 에이전트 CLI·샌드박스 실행, `internal/managedcli` = CLI 설치/버전 관리, `internal/gitegress`·`gitwork` = git 송출/작업.
- 웹 UI: `web/`(임베드, `web/embed.go:5`에 `sops.css`, `orchestrate.js` 등), 채팅 UI `chatbot/`.
- 저장소: MySQL 마이그레이션 `migrations/`.

## 3. GitLab 지원 — 층별로 다르다 (핵심 답)

### (a) clone/push: **지원**
- `docs/deployment.md:101` — "Use Git SSH for GitLab.com, self-managed GitLab, Gitea, Gogs, GitHub…" 예시 `git@gitlab.com:group/repo.git`, `ssh://git@git.example.org:2222/group/repo.git`.
- `docs/deployment.md:105` — 호스트별 SSH 키를 따로 등록(포트 포함), 푸시가 필요하면 쓰기 권한 부여.
- `internal/domain/user.go:61-62` — `GitPlatformGitHub = "github"`, `GitPlatformGitLab = "gitlab"`; `:113` — GitLab은 사용자명이 `oauth2`가 아니면 규칙 적용(토큰 인증 형태).

### (b) MR 추적(상태 새로고침): **지원**
- `internal/domain/mr.go:45-47` — 프로젝트 문자열 접두사로 플랫폼 판별: `github:` → GitHub, `gitlab:` → GitLab.
- `internal/tracker/external_mr.go:50` — `if platform == domain.GitPlatformGitLab` 분기, GitLab은 `PRIVATE-TOKEN` 헤더로 갱신(테스트 `external_mr_test.go:57`이 `PRIVATE-TOKEN` + `/projects/group%2Fsub%2Fapp/merge_requests/3` 경로를 검증).
- `external_mr_test.go:26,41-42` — `gitlab.example.org` 같은 **self-managed 호스트**와 `gitlab:host/group/repo` 프로젝트 키를 그대로 쓴다.
- `internal/tracker/mr_delivery_sync.go` — 5분 주기로 MR 상태(merged/target branch/mergedAt)를 재조회(`mrDeliverySyncInterval = 5 * time.Minute`).

### (c) MR **생성·머지 자동화**: GitHub API + Tencent 내부(Gongfeng) MCP
- GitHub: `internal/tracker/github.go:174-190`(`/pulls` 목록), `:238`(`POST /pulls` 생성).
- 그 외 경로는 **Gongfeng MCP 도구 호출**이다: `internal/tracker/merge_mr.go:65`(`create_merge_request`), `:93`(`merge_merge_request`), `:109`(`search_merge_request`).
- Gongfeng은 Tencent의 GitLab 기반 코드 플랫폼이고, 워크플로 요구사항 키도 `gongfeng-git-token`, `gongfeng-mcp`로 박혀 있다(`internal/domain/workflow.go:31-35`).
- **따라서 평범한 self-managed GitLab에서 MR 생성은 플랫폼이 직접 하지 않는다** → SOP의 `script` 노드에서 `glab mr create`(또는 GitLab API)를 실행하고, 그 URL을 등록하면 (b)의 추적 경로로 들어온다.

### (d) 이슈 가져오기: GitLab 이슈는 없음
- `docs/open-source-scope.md`의 Repository hosting 행: "GitHub reference normalization, Issue import, PR discovery/merge/state refresh".
- `internal/tracker`의 이슈 소스는 GitHub + TAPD + Gongfeng(`service.go:294` `PullAll`, `:853` `pullTAPDPool`). **GitLab 이슈 import 코드는 발견되지 않음(UNVERIFIED로 남길 항목 아님 — 부재 확인)**.

## 4. SOP 구조 (마케팅 문구가 아니라 코드)

- 노드 타입은 4종: `internal/domain/workflow.go:50` — `Type string // agent, script, approval, sop`.
- 실행 분기: `internal/engine/node_execute.go:229`(script/command/approval/sop 사전 처리), `:368`(sop=하위 SOP 실행), `:372`(approval=승인 대기), `:623-632`(script/command 실행).
- 승인 게이트는 상태로 표현된다: `align_test.go:101-102` — `{Type: "approval"}` 노드가 `waiting_approval` 상태가 되면 런이 대기.
- 요구(이슈) 단위 SOP 체인: `internal/domain/issue_sop.go:11-20` `IssueSOPBinding{WorkflowID, Order, DependsOn, Handoff}` + `SOPPlaybook`(같은 파일 24-30) — **SOP 묶음을 이름 붙여 재사용**.
- 사전 점검: `internal/domain/workflow.go:29-35` `WorkflowRequirement{Key, Label, Setup}` — "Git Token 없음/MCP 설정 없음"을 첫 실행 전에 체크리스트로 노출.
- 즉 우리가 말한 "브리프 + 승인 게이트 + 영수증" 구조와 동형이고, **노드 단위 재시도·아티팩트·감사**가 이미 프레임워크화돼 있다.

## 5. 배포 무게 (실측)

`compose.yaml`의 서비스는 **2개**다.
- `mysql` — `image: mysql:8.4` (`compose.yaml:3-4`), utf8mb4, 볼륨 `mysql-data`.
- `platform` — `image: ${LOOPFORGE_IMAGE:-ghcr.io/tencent/loopforge:0.4.0}` (`compose.yaml:20-24`), 포트 `8090:8080`, `AGENTFLOW_MYSQL_DSN`으로 MySQL 연결.
- 샌드박스: `AGENTFLOW_ISOLATED_IMAGE`(`compose.yaml:45`)로 실행 이미지를 따로 두고, 호스트의 워크스페이스 경로를 컨테이너에 그대로 바인드한다(`compose.yaml:53-55` 주석: "Docker sandboxes bind workspace paths on the host, so the data directory keeps the same absolute path inside the container") → **호스트 Docker 실행 환경이 전제**.
- RAM/CPU 요구치는 문서에 수치가 없다 → **UNVERIFIED**. 다만 앱 1 + DB 1 + 태스크별 컨테이너 구조라 7.7GB 노트북 상시 운영은 무리, **팀 서버 1대** 전제가 맞다.

## 6. 에이전트 CLI 연결 방식

- 설치/버전 관리는 npm 레지스트리 기반(`internal/managedcli/registry.go`: npm 메타데이터 fetch, integrity 검증) → CLI를 서버가 직접 설치·고정한다.
- 문서상 지원 목록(README): CodeBuddy, Codex, Claude Code, OpenCode, Cursor CLI, Antigravity, Kimi Code, Pi, DeepSeek Harness, ZCode.
- 개별 CLI→npm 패키지 매핑은 코드에서 열거되지 않아 **UNVERIFIED**(문서 목록 기준).
- 실행은 호스트 프로세스 + Docker 샌드박스 조합: `cmd/agentflow`의 `-cli-provider` 플래그가 `codex, codebuddy, claude-code`(롤백용), `internal/engine/workspace_preparation.go:424-441`이 실행기 종류별 샌드박스 요구사항(예: codex 로그인 릴레이)을 계산.

## 7. dori와 비교

| 축 | LoopForge | dori (현재) |
|---|---|---|
| 작업 단위 | 이슈 → SOP 런 → 노드(agent/script/approval/sop) | 레인 → 브리프 → 세션 |
| 격리 | Docker 샌드박스(호스트 소켓 필요) + 리포별 워크스페이스 | git worktree(레인별) |
| 승인 | `approval` 노드, `waiting_approval` 상태 | 리뷰 게이트 + 영수증 |
| 산출물 | 아티팩트 노드/스토리지 | 커밋 + 문서 + 리뷰 영수증 |
| SCM | GitHub PR 생성/추적, GitLab MR **추적**, Gongfeng 생성 | 브랜치 + 로컬 커밋(PR은 포크 내부만) |
| 재사용 | SOP 체인·플레이북·요구사항 사전점검 | 브리프 파일(표준화 미흡) |
| 무게 | 서버 1 + MySQL + Docker | 이 머신에서 바로 동작 |

## 8. 판단

**도입: 조건부 찬성.** 우리 회사 흐름(로컬 작업 → 큰 PR)과 정확히 같은 방향이고, GitLab도 "추적"까지는 공식 지원이라 반쪽짜리가 아니다. 다만 두 가지를 전제로 한다.
1. **MR 생성은 glab 스크립트 SOP**로 우리가 정의(플랫폼은 추적만). Gongfeng 의존 기능(이슈 동기화·MR 자동 생성)은 우리 환경에서 쓰지 않는다.
2. **서버 1대 + Docker**가 필요하므로 개인 노트북이 아니라 팀 서버에 올린다.

**PoC 3단계**
1. `compose.yaml`로 스택 기동(`scripts/configure.sh` → `docker compose up`) 후 GitHub 리포 1개로 end-to-end 1건.
2. 사내 GitLab 리포를 SSH로 등록(`docs/deployment.md:101-105`) → `glab mr create` 스크립트 노드를 포함한 SOP 1개 작성.
3. 생성된 MR이 `merge_requests`로 추적되는지 확인(`internal/tracker/external_mr.go:50` 경로) — 여기까지 통과하면 도입 확정.

## 9. 미확인 (UNVERIFIED)

- RAM/CPU 최소 사양(문서에 수치 없음).
- CLI별 npm 패키지 매핑과 DeepSeek Harness 지원 깊이.
- self-managed GitLab에서 MR **자동 생성**이 MCP 없이 되는 구성(코드상 GitHub/Gongfeng 경로만 확인).
- 라이선스상 사내 상용 사용 조항(MIT이므로 문제 없음 — `LICENSE` 참조, 별도 검토 불필요).
