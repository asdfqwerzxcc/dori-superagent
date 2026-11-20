# dori link — 계정·ssh 없이 LAN 기기 연결 (v1)

Lee 결정(2026-11-20): ssh 대신 **페어링**이 기본. ssh(`dori remote`)는 폴백으로 남는다.
이 문서는 v1(상태 채널)만 다룬다. `/exec`, 원경 세션 시작, mDNS 자동 발견은 다음 레인이다.

## 명령

```bash
# 대상 머신(에이전트): 포그라운드 데몬. 기본 0.0.0.0:7799
dori agent [--port 7799] [--host 0.0.0.0]

# 같은 머신(호스트): 10분짜리 1회용 코드와 지문, LAN 주소를 찍고 끝난다. 대기 모드 없음
dori link
# CODE 3F7K-92QD  FINGERPRINT ab:cd:…  ADDR 192.168.0.12:7799

# 새 기기: 접속 → 지문 확인 → 코드 입력 → 토큰 저장
dori link 192.168.0.12:7799
dori link 192.168.0.12:7799 --fingerprint ab:cd:… --code 3F7K-92QD --name box2   # 비대화형

# 연결된 기기 상태: 이름 · 주소 · online · CPU/RAM · 세션 · 마지막 응답
dori devices
dori devices remove box2
```

`dori link`(호스트)와 `dori agent`는 같은 `$DORI_HOME`을 쓴다. 코드는 그 홈의
`state/agent-pair.json`에 해시로만 남고, `POST /pair`가 성공하는 순간 삭제된다.
지문은 `dori link`와 `dori agent`가 처음 필요할 때 생성하는 자기서명 인증서에서 나온다
(`state/agent-cert.pem`, `state/agent-key.pem`).

## 보안 모델

- **직접 암호 구현 없음**: 키·서명·해시는 `node:crypto`가 한다. 이 리포가 직접 쓰는 것은 X.509 컨테이너(DER)뿐이다.
- **자기서명 TLS + 지문 pinning**: 공인 CA가 없다. 클라이언트는 상대 인증서의 SHA-256 지문을
  사람이 대조하게 하고, 그 인증서 PEM을 TLS의 유일한 trust anchor로 넘긴다. 지문이 저장값과 다르면
  연결을 거부한다. `--replace` 없이는 저장된 지문을 갱신하지 않는다.
- **토큰**: 32바이트 랜덤(base64url). 에이전트는 SHA-256 해시만 `state/agent-tokens.json`에 저장한다.
  토큰이 없거나 틀리면 `/status`도 401이다(단 `/pair`는 예외).
- **코드**: 8자리, 1회용, 10분. O/0·I/1을 뺀 알파벳이라 화면에서 옮겨 적을 때 두 표기가 생기지 않는다.
  만료·재사용·오타는 모두 403으로 끝난다.
- **지문 불일치**: `dori link`가 저장된 지문과 다른 인증서를 만나면 연결을 거부하고 두 지문을 보여준다.
  기기를 재설치해 인증서가 바뀐 경우에만 새 코드로 다시 페어링하고 `--replace`를 쓴다.

## LAN 전용

기본 바인딩은 `0.0.0.0`이지만 **같은 LAN 안에서만 쓴다.** 인터넷에 포트를 열지 않는다.
방화벽·라우터 포워딩·리버스 프록시로 노출하지 말 것. 토큰이 유일한 잠금이고,
그 토큰은 페어링한 기기들에만 있다.

## 파일

| 무엇 | 어디 |
|---|---|
| 에이전트 인증서·키 | `$DORI_HOME/state/agent-cert.pem`, `state/agent-key.pem` |
| 1회용 코드(해시) | `$DORI_HOME/state/agent-pair.json` |
| 발급 토큰(해시) | `$DORI_HOME/state/agent-tokens.json` |
| 연결된 기기(토큰·지문·인증서) | `$DORI_HOME/config/devices.json` |

`devices.json`은 클라이언트 쪽 비밀이다. 0600으로 쓰고, 리포에 커밋하지 않는다.

## 이번 범위가 아닌 것

- `/exec`, 원경 세션 시작, 원경 레인 — 다음 레인에서 이 채널 위에 올린다.
- 서비스 설치(윈도우 서비스/systemd), mDNS 자동 발견 — v2.
- 지문 대신 ssh 호스트 키를 쓰는 하이브리드 — ssh는 `dori remote`로 남겨 둔다.
