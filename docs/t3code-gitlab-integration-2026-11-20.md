# T3 Code의 GitLab 연동 방식 — 소스 조사 (2026-11-20)

조사 대상: `https://github.com/pingdotgg/t3code` · HEAD `e6e1ce70c85fed137ff8b176e21fe19c041c43d3` (main, 2026-11-20, ★67,108)
비교 대상: GOAT 포크 `C:/Users/USER/.dori/tmp/goat-work` (T3 Code 계열, 같은 패키지 레이아웃)

## 0. 한 줄 결론

**T3 Code는 GitLab을 '1급 SCM'으로 내장 지원한다.** 방식은 REST 토큰이 아니라 **`glab` CLI 재사용**이다: `glab auth status`로 인증된 호스트(self-managed 포함)를 찾고, MR 생성·조회·병합은 **`glab api` + GraphQL**로 수행한다. GOAT는 이 패키지를 그대로 물려받았고, 이슈 트래커만 덜어낸 상태다.

## 1. SCM 계층 구조 (T3)

- 드라이버 목록: `apps/server/src/sourceControl/sourceControlDefinitions.ts:8`(`import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver"`), `:11-14`에서 `BUILT_IN_SOURCE_CONTROL_DRIVER_LIST` = GitHub, **GitLab**, GitCafe, Forgejo, Bitbucket, AzureDevOps.
- 조립: `apps/server/src/sourceControl/builtInDrivers.ts:24`가 각 드라이버의 `make`를 순서대로 실행해 `SourceControlDrivers` 서비스를 만든다. 즉 **모든 SCM은 같은 인터페이스**로 붙는다.
- 패키지: `packages/source-control-{core,definitions,github,gitlab,gitcafe,forgejo,bitbucket,azure-devops,cursor-origin,testing}`.

## 2. GitLab 패키지 안에서 무슨 일이 일어나나

- `driver.ts` — `defineSourceControlDriver({kind: definition.kind, definition, make})`로 `sourceControl`·`discovery`·`pullRequests`·`issues` 4개 서비스를 묶는다(`:12-24`).
- **인증 탐색**: `GitLabSourceControlProvider.ts:61` `findAuthenticatedGitLabHost(parseGitLabAuthStatusHosts(output))` — `glab auth status` 출력을 파싱해 **인증된 GitLab 호스트**를 고른다(`gitLabAuthStatus.ts:44`). 그래서 `gitlab.com`뿐 아니라 **self-managed 호스트**도 그대로 동작한다(호스트별 인증 상태를 읽으므로).
- **원격→프로바이더 판별**: `parseGitRemoteHost` + `unknownRemoteProvider`(`GitLabSourceControlProvider.ts:9-12`)로 git remote를 읽어 어떤 드라이버인지 결정한다.
- **MR 생명주기**: `GitLabPullRequestProvider.ts`가 `GitLabPullRequestCli.ts`에 위임하고, 그 안에서 `glab api`(+`graphqlListQuery`, `:869`)로 목록·상세·diff를 가져온다.
  - 병합은 `glab mr merge`를 쓰지 않고 API로 간다 — 코드 주석: "`glab mr merge` arms auto-merge and never disarms it, so the one direction the CLI has…"(`GitLabPullRequestCli.ts:2816`). 즉 **CLI의 부작용을 피하려고 병합만 API 직접 호출**.
- **MR 템플릿**: `gitLabChangeRequestTemplate.ts:6` — `.gitlab/merge_request_templates` 디렉터리를 읽는다(리포 규약 존중).
- **이슈 트래커**: `GitLabIssueTracker.ts:2` "GitLab's issue tracker over `glab api`. GitLab pages by offset…" — 페이지네이션을 `glab api --include`의 next-page 헤더로 처리(`:117`).

## 3. 그래서 "GitLab 연동 방법"은 이 5단계다

1. **CLI 인증**: 대상 호스트에 `glab auth login`(토큰은 glab이 보관). 코드는 토큰을 직접 다루지 않는다.
2. **호스트 탐색**: `glab auth status` 파싱 → 인증된 호스트 목록 → 리포 remote의 호스트와 매칭.
3. **드라이버 선택**: remote 호스트/경로로 `gitlab` 드라이버 인스턴스 생성(다른 SCM도 동일 경로).
4. **MR 작업**: 목록·상세·diff는 `glab api`(+GraphQL), **생성/병합은 API 직접 호출**(CLI 부작용 회피).
5. **리포 규약**: `.gitlab/merge_request_templates`를 읽어 본문 템플릿을 채운다.

## 4. GOAT 포크와의 차이 (상속 확인)

- GOAT도 `packages/source-control-gitlab`을 그대로 갖고 있고, 드라이버 등록도 동일하다(`apps/server/src/sourceControl/sourceControlDefinitions.ts:8`, `builtInDrivers.ts:24` — 패키지명만 `@goat/...`).
- 파일 단위 차이(디렉터리 diff):
  - GOAT에 **없음**: `GitLabIssueTracker.ts`, `gitLabIssueJson.ts` → 이슈 트래커 슬라이스를 덜어냄
  - GOAT에 **추가**: `gitLabPullRequestActionErrors.ts`, `GitLabPinnedMerge.test.ts` → 액션 에러 처리·병합 핀 테스트 추가
- 즉 **GitLab MR 연동 자체는 T3에서 그대로 물려받았고**, 포크가 손댄 부분은 이슈/에러/병합 테스트다.

## 5. 우리에게 주는 시사점

- **우리 `glab-backend`(백로그 p3)도 같은 패턴이 정답**: 토큰 REST를 새로 설계하지 말고 `glab auth status` 탐색 + `glab api` 호출. self-managed GitLab이 자동으로 커버되고, 인증 관리는 glab에 맡긴다.
- **병합만은 API 직접**: CLI의 auto-merge 부작용을 피하는 T3의 판단은 우리 `dori merge` 게이트에도 그대로 적용할 만하다.
- **템플릿은 리포 규약**: `.gitlab/merge_request_templates`가 있으면 그걸 읽는 쪽이 사용자 기대에 맞다.
- **드라이버 인터페이스**: SCM을 `sourceControl/discovery/pullRequests/issues` 4면으로 나누는 구조는 우리 `gh-sweep`/`stale`/`labels`를 GitHub·GitLab 공통으로 추상화할 때 그대로 참고할 수 있다.

## 6. 미확인 (UNVERIFIED)

- `glab` 최소 버전 요구(코드에 버전 게이트가 있는지 미확인).
- GitLab 병합 시 auto-merge 상태를 API로 어떻게 되돌리는지(주석만 확인, 구현 세부 미확인).
- GOAT가 이슈 트래커를 뺀 이유(커밋 이력 미확인 — 포크 결정인지 upstream 이전 시점 차이인지).
