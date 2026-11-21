# 최종 정리 — 2026-11-20 (단일 기준 문서)

오늘 대화에서 확정된 구조를 한 장으로 모은다. 충돌 시 이 문서가 우선한다.

## 1. 제품 3층

| 층 | 무엇 | 소유하는 것 | 소유하지 않는 것 |
|---|---|---|---|
| **Helmr** | 제품/거버넌스 | SOP 정의·승인 게이트·영수증·감사, 판단 UI(번들 MR 리뷰 화면) | 실행, 코드 상태 |
| **dori** | 엔진/오케스트레이션 | 레인·워크트리·브리프·리뷰 게이트·`status:*` 라벨·백로그, 상태 | UI, LLM UI |
| **up.computer** | 셸(UI) | 채팅·스레드·워커·태스크 화면 표시 | 상태 일절 |

- **LoopForge는 서버를 쓰지 않는다. 개념만** 차용: `agent | script | approval` 노드, "SOP로 묶음 처리 절차를 표준화". 서버 내장은 상태 소유자 이중화라 배제.
- **GOAT/up.computer 포크 금지**: 우리 GOAT 포크가 17일 만에 655커밋 뒤졌다. upstream 그대로 + `dori acp` 프로바이더 등록. seam이 없을 때만 얇은 패치, upstream PR 우선.

## 2. 도리 토폴로지

**메인 도리 = PM 모드 (2026-11-20 확정)** — 코드를 읽지 않고 **계획·할당·추적·보고**만 한다. 입력은 마일스톤 이벤트 + 당겨 읽은 상태 + 사람의 요구, 출력은 백로그·브리프·리마인더·보고·차단 에스컬레이션. 코드·diff 판단은 프로젝트 도리와 게이트 UI의 몫이다.

```
메시징(Discord → Zulip/Mattermost, 미국만 Slack 브리지)
  ↕
메인 도리 (1개)  · 백로그·승인·프로젝트 조정·다채널 인박스
  ↕ (브리프 / 브랜치 / 영수증 요약)
프로젝트 도리 (리포마다 1개, 별도 DORI_HOME)
  ↕
사람 ↔ 프로젝트 도리 직접 코딩 (up.computer 스레드 = ACP 세션)
```

- **사람은 프로젝트 도리와 코딩**하고, **메인 도리는 그 대화를 엿듣지 않는다.** 프로젝트 도리가 **마일스톤만** 한 줄로 보고하고(레인 시작/ready/blocked/게이트 대기), 메인은 필요할 때 상태·영수증을 당겨 읽어 **다음 일을 브리프로 넘긴다**. 대화 원문은 프로젝트에만 둔다.
- **상태 경계**: 백로그·게이트=메인, 레인·영수증=프로젝트, 코드·PR·라벨=리포, 대화=메시징. 공유 상태 파일 없음.
- **다채널 인박스**: `{source, channelId, threadId, author, text, attachments, ts, replyTo, isOwner}` 정규화 → 라우터(우선순위·프로젝트 라우팅) → origin 회신. 비용 가드(원문 전부 컨텍스트 금지), 권한(소유자 아닌 요청은 제안까지만).

## 3. 원격 머신

- **원격에 도리를 설치하지 않는다.** 원격은 **얇은 데몬** 또는 **에이전트 CLI(omo) 직접 실행**.
- 두 변형:
  1. `ssh host '… git worktree add … && omo -p "$(cat brief)"'` — 원격 준비물 `git+bun+omo`뿐. **오늘 바로 가능.**
  2. `dori agent` 얇은 데몬 — 세션·worktree·파일 I/O만 노출(두뇌 없음).
- **연결은 페어링 단일 경로**: `dori link`(8자 코드+지문) → `dori devices`(online·CPU/RAM·세션·마지막 응답) → `dori remote start`가 `/exec` 호출. **ssh 경로는 삭제**한다.
- GOAT의 `~/.ssh/config` 자동 발견은 차용 가치 있음.

## 4. MR 스프롤 해결 (오늘 확정한 동기)

- 문제는 에이전트 성능이 아니라 **MR 개수**. 작은 MR이 쌓이면 검토 비용이 MR 수에 비례.
- **묶음(bundle)이 작업 단위**: 대표 이슈 + 관련 이슈 → 브랜치 1 → MR 1. 최대 10개.
- **한 번들 = 한 게이트**: SOP 노드가 여러 개여도 사람이 결정하는 지점은 하나.

## 5. SOP 판단 UI (Helmr의 본체)

> **대체됨 (2026-11-21, lane `gate-ui-mr`)**: 커스텀 판단 UI는 만들지 않는다. 번들 MR의 리뷰·체크 화면이 그
> 화면이다 — `dori sop gate show`가 판단 근거를 MR 코멘트로 게시하고, `dori sop sync`가 승인/변경 요청을
> `approve`/`reject`와 같은 영수증으로 기록한다. 아래 Gate inbox/상세 요구는 MR 화면이 충족하는 항목과
> 폐기된 항목으로 읽는다.

- **Gate inbox**: `프로젝트·번들·노드·기다린 시간`, 위험 표시 우선(범위 밖 파일·검증 없음).
- **SOP run 상세**: 노드 체인 상태 + diff stat + 번들 구성원 + 실행된 검증 + 실패 로그. 결정: 승인/변경 요청(사유)/건너뜀/재실행/중단. 모든 결정은 영수증.
- **데이터는 dori 소유**: `sops/<id>.json`, `state/sop-runs.json`, `dori sop list|show|approve|reject|skip|rerun`. UI는 API만 사용.

## 6. 이미 착지한 것

- `dori labels` / `dori stale` / PR 템플릿 / `config/repos.json` allowlist (커밋 `f357df6`)
- `dori remote add|list|start` LAN ssh (커밋 `4f9d6c0`, Windows는 `powershell -EncodedCommand`)
- 백로그 가드 수정 + 읽기 경로 reconcile (`5bec6dd`, `ea77519`)
- T3 Code의 GitLab 연동 방식 조사: **glab CLI + glab api, 병합만 API 직접** (`07d6a87`) → `glab-backend` 백로그 p3의 설계 근거

## 7. 확정 vs 보류

**확정**
- Helmr=거버넌스, dori=엔진, up.computer=셸, 포크 금지
- 묶음 우선 + 한 번들 한 게이트
- 원격은 얇은 데몬/omo 직접 실행 (dori 설치 없음)
- SOP 판단 UI의 데이터 소유자는 dori

**보류(결정 필요)**
1. 프로젝트 단위 = 리포 1개인가
2. 사내 채팅 도입 시점(Zulip vs Mattermost)
3. 페어링 전환 시점(ssh 폴백 유지 전제)
4. up.computer 설치·검증 시점(현재 미설치)
5. Helmr을 제품명으로 확정하는가

## 8. 권장 진행 순서

1. **`glab-backend`**(p3) — 회사 GitLab이 실제 업무 경로. T3 패턴(인증 탐색 + glab api)으로.
2. **`dori sop` 데이터 모델 + CLI** — Gate inbox의 토대.
3. ~~Gate inbox 실데이터 목업(ds-v4)~~ — **폐기**: 번들 MR 리뷰 화면을 그대로 쓰고 `dori sop gate show`/`sync`로 잇는다.
4. **페어링 + `dori devices`** — 원격 ergonomics.
5. **up.computer 설치·`dori acp` 등록** — 셸 검증.
6. **LoopForge식 SOP 템플릿**으로 번들 처리 자동화.

각 단계는 레인 1개, 증거(테스트·실행 로그·스크린샷) 첨부로 착지한다.
