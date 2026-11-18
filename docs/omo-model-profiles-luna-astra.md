# omo 모델 프로필 — Luna / Astra 실제 정의

출처: `~/.bun/install/global/node_modules/omo-ai/plugin/extensions/omo.js` (omo 5.1.75, 2026-11-18 확인).
senpi 엔진에는 프로필 개념이 없고, 전부 omo 플러그인 쪽입니다.

## 모델 변수 → 실제 id

| 변수 | 모델 |
|---|---|
| sv | gpt-6-astra |
| dv | gpt-6.1-sol-fast |
| lv | gpt-6.1-sol |
| cv | gpt-6-luna-fast |
| rv | claude-opus-5-5 |
| av | claude-fable-5-2 |
| pv | kimi-k3.1-pro |

프로바이더 그룹:
- **Nce** = chatgpt-subscription, openai, github-copilot, opencode
- **Rce** = anthropic-subscription, anthropic, anthropic-api, github-copilot, opencode
- **Dce** = chatgpt-subscription, openai

## 프로필 정의(코드 그대로)

**daily-normal** — "Daily · Normal" / "Gets any task done without fuss."
1. `rv`(claude-opus-5-5) on Rce, variant **medium**
2. `av`(claude-fable-5-2) on Rce, **medium**
3. `pv`(kimi-k3.1-pro) on kimi-coding/kimi-for-coding/moonshotai/opencode-go, **max**

**daily-heavy** — "Daily · Heavy" / "Gets any task done, after thinking it over from more sides."
1. `av`(claude-fable-5-2) on Rce, **high**
2. `claude-fable-5-1` on Rce, **xhigh**

**geeky-normal** — "Obsessive · Normal" / "Obsessive focus on one hard task."
caution: **NOT RECOMMENDED FOR WRITING OR EVERYDAY WORK.**
1. **`sv` = gpt-6-astra** on Nce, **medium**
2. `dv` = gpt-6.1-sol-fast on Dce, medium
3. `lv` = gpt-6.1-sol on Dce, medium
4. `gpt-5.6-sol` on Nce, medium

**geeky-heavy** — "Obsessive · Heavy" / "…checked from every side."
1. **`sv` = gpt-6-astra** on Nce, **high**

## Luna는 어디에 있나

- Luna는 **프로필 체인에 등장하지 않습니다**. `gpt-6-luna` / `gpt-6-luna-fast`는 **프로바이더의 선택 가능한 모델 id 목록**에만 있습니다(변수 `cv` = gpt-6-luna-fast로 별도 보관).
- 즉 프로필이 지배하는 자리(리드·카테고리 기본값)에서는 **geeky 계열이 Astra를 1순위로** 잡고, Luna는 체인의 런그가 아니라 "직접 고를 수 있는 id"입니다.

## 그래서 "Luna를 골랐는데 Astra로 최적화된다"가 나오는 이유

1. 프로필이 유효하면 그 체인의 1순위가 배정됩니다(geeky-normal/heavy → **Astra**).
2. Luna는 그 체인에 없으므로 리드/기본값으로 승격되지 않습니다.
3. 카테고리에 **구체 모델 id**를 적으면 프로필 해석보다 우선합니다(예: `categories.quick.models = ["opencode-go/gpt-6-luna-fast"]`).

## 실무 권장

- 일상 작업은 `daily-*`(Anthropic 계열 중심), 집요한 단일 과제만 `geeky-*`(Astra).
- Luna로 실제 실행하려면 카테고리에 id를 명시하고, 리드에는 Astra(또는 안정적인 상위 모델)를 유지.
- 확인: 응답의 `model` 필드와 과금 단가 — Luna 단가인데 model이 Astra면 프로필이 이긴 것.
