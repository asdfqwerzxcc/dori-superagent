# 모델 컨텍스트에 실제로 들어가는 것 (캡처 실측)

캡처 방법: senpi 엔진 엔트리(`dist/bundle/cli.js`)를 `bun --preload`로 감싸 fetch를 가로채 요청 본문을 저장.
omo 런처는 node→bun 재실행 시 node 플래그를 버리므로(`execArgv` deliberately dropped) 엔진 CLI를 직접 실행했다.

```
bun --preload <dump-fetch.ts> <senpi>/dist/bundle/cli.js -p --no-session \
  --model opencode-go/deepseek-v4.1-flash "reply with exactly: hi"
```

## 캡처된 요청

- 엔드포인트: `POST https://opencode.ai/inference/go/v1/chat/completions`
- model: `deepseek-v4.1-flash`, stream: true
- **tools: 13개**, messages: **2개**(system + user)
- 본문 크기: 약 40 KB

| 메시지 | 크기 |
|---|---|
| system | 16,284 chars (~4천 토큰) |
| user | 191 chars |

## 시스템 프롬프트 구성 (12개 블록)

| 블록 | 크기 |
|---|---|
| (머리말) "You are senpi, a coding agent running on DeepSeek V4.1 Flash …" | 191 chars |
| ## Intent Gate | 1,279 |
| ## Scope | 1,010 |
| ## Working the Task | 1,455 |
| ## Verification | 276 |
| ### Test Discipline | 979 |
| ## Tool Guidelines | 1,102 |
| ## Handoff | 902 |
| **## Style** | **6,059** |
| ## Todo Management | 161 |
| ## Evidence | 167 |
| ## Persistent terminal sessions | 2,692 |

가장 큰 블록은 **Style(6,059자)** 이고, 그 다음이 Persistent terminal sessions(2,692), Working the Task(1,455).

## 여기엔 없지만 리드 대화형 세션엔 추가되는 것

`-p --no-session` 원샷에는 아래가 붙지 않는다. 대화형 세션에서는 프롬프트에 더해진다:
- 메모리 투영 블록(`<self>`, `<agreements>`, `<memory>`, `<human>` …)
- 프로젝트 메모리 / AGENTS.md 블록
- 스킬 목록(이름+설명)과 조건부 활성 스킬
- 모드 지시문(예: ultrawork), 툴 안내 확장

## 핵심 결론

- omo의 프로필/`최적화` 문구는 **요청 본문에 없다**. 프로필은 `model`과 `variant`(사고 수준)만 정한다.
- 컨텍스트는 **엔진이 매 호출마다 조립**하며, 세션 파일에는 저장되지 않는다(그래서 이 캡처가 유일한 방법).
- 토큰을 줄이려면 **Style(6KB)·Persistent terminal sessions(2.7KB)** 부터 손대는 게 효과가 크다.
