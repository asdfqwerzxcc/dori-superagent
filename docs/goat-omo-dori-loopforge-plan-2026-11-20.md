# GOAT 개조안: 엔진=omo, 봇=도리, 페어링 유지, LoopForge 개념 삽입 (2026-11-20)

## 요구 4개
1. GOAT의 기본 엔진을 **omo 기반**으로.
2. GOAT 봇을 **도리**로.
3. **페어링은 그대로**.
4. **LoopForge 개념**(에이전트/스크립트/승인 게이트 노드)을 안에 넣기.

## 현재 상태 (실측)

- GOAT 소스: `C:/Users/USER/.dori/tmp/goat-work` (goat-si/goat, T3 Code 포크, `apps/{desktop,server,web,mobile}` + `packages/provider-*`).
- **GOAT는 ACP 기반 프로바이더 구조**다: `packages/provider-core/src/client.ts`가 `acpRegistryAgentIds`를 갖고, `effect-acp`·`provider-acp`·`provider-acp-registry`가 있다. 즉 **에이전트는 ACP로 붙는다**.
- **dori는 이미 ACP를 말한다**: `dori acp` (`skills/dori-mode/scripts/src/acp.ts`, `src/acp/{server,protocol,backend}.ts`). 백엔드는 **`senpi --mode rpc` 자식 프로세스**(`src/acp/backend.ts`) → 즉 **omo 엔진 그 자체**다.
- GOAT에 등록하는 절차도 이미 검증됨: Settings → Providers → Add provider → ACP source: **Local command**, Executable `dori`, Arguments `acp`. 피커에 **Dori**로 뜬다.
- 제약 2개:
  - 프로바이더 변경은 **사람만** 가능(`providers:manage`; 에이전트/CLI는 `capability_denied`).
  - 현재 ACP 세션은 **채팅 전용**이고 레인 실행에 재사용하지 않는다(재귀 가드 포함).

## 판정

**기술적으로 전부 가능하고, 1·3번은 이미 되는 상태**다. 진짜 작업은 2번(봇 교체)과 4번(SOP), 그리고 "스레드=레인" 매핑이다.

## 단계

**P0 — 엔진=omo 확정 (작음)**
- GOAT 포크에 (a) 기본 프로바이더 설정, (b) `dori acp` 자동 등록(부트 시) 추가.
- 효과: 새 스레드가 기본적으로 Dori(=omo/senpi)로 열린다. UI·페어링 무변경.

**P1 — 봇 아이덴티티 교체 (중간)**
- GOAT 봇 표면(수신·발신)을 **dori 게이트웨이로 위임**. 페어링·기기 목록은 GOAT 것을 그대로 사용.
- 주의: 이전 결정("도리 따로 고트 봇 따로")을 **뒤집는 변경**이다 — 명시 승인 필요.

**P2 — 스레드=레인 매핑 (큼)**
- 지금 ACP는 채팅 전용 → 스레드를 **dori 레인으로 열고** 진행/브리프/영수증을 GOAT UI에 노출하려면 ACP 어댑터 확장이 필요하다(프로토콜 확장 또는 ACP 밖의 RPC).
- 대안(작게): 스레드는 채팅으로 두고, "레인 열기" 버튼이 `dori start`를 호출해 **별도 레인**을 띄우고 링크만 UI에 붙인다.

**P3 — LoopForge 개념 삽입 (중간)**
- LoopForge 서버를 내장하지 말고 **개념만** 가져온다: `agent | script | approval` 노드 = GOAT 스레드 묶음 + dori 게이트(승인은 기존 리뷰 영수증 재사용).
- 저장은 dori 쪽 파일(`$DORI_HOME/sops/*.json`), 실행은 dori, 표시는 GOAT.
- LoopForge를 실제로 넣으면 상태 소유자가 둘이 되어(이미 문서화한 경계 위반) 권장하지 않는다.

## 리스크

- **포크 유지비**: GOAT는 큰 TS 모노레포(T3 Code 계열). upstream 변경을 계속 흡수해야 한다.
- **권한 경계**: 프로바이더 자동 등록은 `providers:manage` 제약과 충돌 → 자동화하려면 포크에서 그 게이트를 완화해야 한다(보안 영향 검토 필요).
- **상태 이중화**: GOAT 스레드 상태 vs dori 레인 상태. P2에서 어느 쪽이 진실원인지 못 박아야 한다(권장: dori).

## 결정 필요 3개

1. **GOAT를 제품 셸로 확정**하는가(기존 "도리=서버, 고트=렌더러" 결정을 뒤집는 것). 
2. **P2를 '스레드=레인'까지 갈지**, 아니면 '레인 링크' 수준에서 멈출지.
3. **LoopForge는 개념만** 가져오는 것으로 확정하는가(서버 내장 배제).
