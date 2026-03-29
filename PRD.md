# OpenClaw Harness v1 — Product Requirements Document

**작성일**: 2026-03-29  
**작성자**: Sol (☀️)  
**대상 독자**: Mason  
**상태**: Draft v1.1 (Mason 피드백 반영: cross-model review, tier 0/1/2, 리뷰 루프 4회)

---

## 1. 배경과 문제

### 현재 상황
OpenClaw는 이미 강력한 에이전트 인프라를 갖추고 있다:
- 멀티채널 메시징 (Telegram, Discord, Signal, Slack 등)
- ACP 런타임 (`sessions_spawn(runtime="acp", agentId="codex"|"claude")`)
- 서브에이전트 스폰 (`sessions_spawn`)
- Memory V3 (pgvector 기반 장기 기억)
- Cron / Heartbeat
- 스킬 시스템

그러나 **코딩 작업을 체계적으로 분해하고, 실행하고, 검증하는 루프**는 아직 수동이다:
- Mason이 직접 "이거 해줘" → 에이전트가 작업 → Mason이 직접 리뷰
- 에이전트가 scope creep을 하거나, 핵심을 빠뜨리거나, 과잉 구현해도 자동 감지가 없음
- 병렬 작업 시 컨텍스트가 부모 에이전트에 쌓여서 성능이 떨어짐 (context rot)
- 리뷰 품질이 "에이전트 기분"에 의존함 — 시스템 강제가 아님

### 핵심 문제 한 줄
> **에이전트는 똑똑하지만, 작업 루프가 강제되지 않아서 품질이 불안정하다.**

---

## 2. 목표

### 이 하네스가 해결하는 것
1. **작업을 Plan → Work → Review 루프로 강제**하여 품질을 안정화한다.
2. **갭 감지를 구조화**하여 scope creep, 핵심 누락, 과잉 구현을 자동으로 잡는다.
3. **서브에이전트를 context firewall로 활용**하여 부모 컨텍스트 오염을 방지한다.
4. **Telegram(또는 다른 채널)에서 바로 사용**할 수 있게 한다.

### 이 하네스가 해결하지 않는 것 (v1 비목표)
- 멀티 LLM consensus / debate (claude-octopus 스타일)
- 브라우저 자동화 / 컴퓨터 사용
- CI/CD 연동 (PR 자동 생성, merge 자동화)
- 여러 코딩 에이전트를 동시에 10개+ 병렬 실행
- 커스텀 대시보드 UI

---

## 3. 사용 시나리오

### 시나리오 A: 단순 코딩 작업
```
Mason: "ClawNode 웹사이트에 FAQ 섹션 추가해줘"

하네스 판단: 복잡도 낮음 → solo 모드
→ Worker(Codex ACP)가 바로 구현
→ 자동 Review 실행
→ Review 통과 → 결과 보고
→ Mason 확인
```

### 시나리오 B: 중간 복잡도 작업
```
Mason: "V4 인스톨러에 OpenRouter 선택지 추가하고, post-wizard도 업데이트해"

하네스 판단: 복잡도 중간, 태스크 2개 → parallel 모드
→ Planner가 태스크 분해
  - Task 1: 인스톨러 OpenRouter 선택 UI
  - Task 2: post-wizard 검증 로직
→ Worker 2개 병렬 실행 (각각 ACP Codex)
→ Reviewer가 각 결과 검토
  - gap_type: missing_core (post-wizard에서 OpenRouter 검증 누락)
→ 1회 수정 재실행
→ 통과 → 보고
```

### 시나리오 C: 고복잡도 작업
```
Mason: "Memory V2 서비스를 Rust로 완전 재작성해"

하네스 판단: 복잡도 높음, 태스크 4개+ → full 모드
→ Planner가 상세 계획 수립
→ Mason에게 계획 승인 요청 (Ask 모드)
→ 승인 후 Worker 병렬 실행
→ Reviewer 5관점 리뷰
→ 갭 발견 시 1회 수정
→ 그래도 갭이면 Mason에게 에스컬레이션
```

### 시나리오 D: 자율 위임
```
Mason: "오늘 밤 사이에 이 이슈 3개 다 처리해놔"

하네스 모드: Autonomous
→ Planner가 3개 이슈 각각 분해
→ Worker 병렬 실행
→ Reviewer 자동 검토
→ 통과한 것은 커밋
→ 실패한 것은 아침에 Mason에게 요약 보고
```

---

## 4. 아키텍처

### 전체 흐름
```
요청 → Router
         │
         ├─ tier 0 (설정/문서/패치)
         │   → OpenClaw 에이전트가 직접 수정
         │   → 완료 보고
         │
         ├─ tier 1 (단순~중간 코딩)
         │   → ACP Codex 구현
         │   → ACP Codex 리뷰
         │   → gap 발견? ─yes─→ ACP Claude 수정
         │       │                    │
         │       no                   ▼
         │       │              ACP Codex 재리뷰
         │       ▼               (최대 4회 루프)
         │   완료 보고                 │
         │                        4회 초과 시
         │                        Mason 에스컬레이션
         │
         └─ tier 2 (고복잡도)
             → Planner가 태스크 분해
             → Mason 승인 (Ask/Delegate에 따라)
             → claude-realtime.sh 구현
             → ACP Codex 리뷰
             → gap 발견? ─yes─→ ACP Claude 수정
                 │                    │
                 no                   ▼
                 │              ACP Codex 재리뷰
                 ▼               (최대 4회 루프)
             완료 보고
```

### 모델 역할 배정 (cross-model review)
| 단계 | 실행자 | 이유 |
|------|--------|------|
| **구현 (tier 0)** | OpenClaw 직접 | 설정/문서/단순 패치는 ACP 불필요 |
| **구현 (tier 1)** | ACP Codex | 코딩 특화, 비용 효율 |
| **구현 (tier 2)** | claude-realtime.sh | 고복잡도, Mason 직접 감독 가능 |
| **리뷰 (전체)** | ACP Codex | 구현자와 다른 모델이 리뷰 = cross-model check |
| **리뷰 수정** | ACP Claude | 리뷰어(Codex)와 다른 모델이 수정 = 관점 교차 |

이 구조의 핵심: **같은 모델이 만들고 같은 모델이 리뷰하면 같은 실수를 놓친다.**
구현 → 리뷰 → 수정 각각 다른 모델을 쓰면 blind spot이 줄어든다.

### 구성 요소 설명

#### 4.1 Router
**역할**: 들어온 요청의 복잡도를 판단하고 실행 tier를 결정한다.

| Tier | 실행자 | 조건 | 파이프라인 |
|------|--------|------|-----------|
| `tier 0` | OpenClaw 직접 | 설정/문서/단순 패치 | 직접 수정 → 보고 |
| `tier 1` | ACP Codex | 단순~중간 코딩 | Work → Review loop |
| `tier 2` | claude-realtime.sh | 고복잡도, 아키텍처 결정 | Plan → 승인 → Work → Review loop |

라우팅 계층 (Citadel 참고):
1. **패턴 매치** (0 토큰): 설정 변경, 오타 수정 → tier 0
2. **키워드** (~0 토큰): "리팩토링", "새 기능", "버그 수정" → tier 1
3. **LLM 분류** (~500 토큰): "마이그레이션", "재작성", 복합 태스크 → tier 2

#### 4.2 Planner
**역할**: 요청을 구체적인 태스크로 분해하고, 각 태스크의 acceptance criteria를 정의한다.

출력 형식:
```yaml
plan:
  id: plan-20260329-001
  original_request: "V4 인스톨러에 OpenRouter 선택지 추가"
  tasks:
    - id: task-1
      title: "인스톨러 OpenRouter 선택 UI"
      scope: "openclaw-setup-v4.sh의 configure_enrichment_backend() 수정"
      acceptance_criteria:
        - "사용자에게 Local Ollama / OpenRouter 선택 프롬프트 표시"
        - "OpenRouter 선택 시 API 키 입력 및 Keychain 저장"
      agent: codex
    - id: task-2
      title: "post-wizard OpenRouter 검증"
      scope: "post_wizard_verify() 수정"
      acceptance_criteria:
        - "OpenRouter 선택 시 enrichment 연결 테스트"
      agent: codex
  mode: parallel
  estimated_complexity: medium
```

#### 4.3 Dispatcher
**역할**: 계획에 따라 Worker를 spawn하고 병렬 실행을 관리한다.

- 실행 엔진: `sessions_spawn(runtime="acp", agentId="codex"|"claude")`
- 각 Worker는 독립 세션 (context firewall)
- Worker에게 전달하는 것: task spec + 관련 파일 경로
- Worker에게 전달하지 않는 것: 다른 Worker의 중간 결과, 부모의 전체 컨텍스트

#### 4.4 Worker
**역할**: 개별 태스크를 실행한다.

실행자는 Router의 tier에 따라 결정된다:
- **tier 0**: OpenClaw 에이전트가 직접 edit/write (ACP 불필요)
- **tier 1**: ACP Codex (`sessions_spawn(runtime="acp", agentId="codex")`)
- **tier 2**: claude-realtime.sh (tmux 기반, Mason 감독 가능)

완료 시 결과 요약만 부모에게 반환 (전체 로그 아님).

반환 형식:
```yaml
result:
  task_id: task-1
  status: completed
  summary: "configure_enrichment_backend()에 OpenRouter 선택지 추가 완료"
  files_changed:
    - openclaw-setup-v4.sh (lines 1205-1280)
  tests_run: 0
  warnings: []
```

#### 4.5 Reviewer
**역할**: Worker 결과를 검토하고, 갭을 구조화된 형식으로 보고한다.

**5종 Gap Taxonomy** (openclaw-harness 참고):

| 갭 유형 | 설명 | 예시 |
|---------|------|------|
| `assumption_injection` | 요청에 없는 가정을 추가 | "JWT 인증을 자의적으로 추가" |
| `scope_creep` | 요청하지 않은 기능/복잡도 추가 | "TODO 앱에 알림 시스템 추가" |
| `direction_drift` | 전체 방향이 의도와 다름 | "단순 API가 풀스택 프레임워크로" |
| `missing_core` | 핵심 기능 누락 | "검색 기능 구현 안 함" |
| `over_engineering` | 과도한 추상화/일반화 | "단순 CRUD에 DI 컨테이너" |

Reviewer 출력 형식:
```yaml
review:
  task_id: task-1
  result: fail
  gaps:
    - type: missing_core
      evidence: "OpenRouter API 키 Keychain 저장 로직이 없음"
      fix_hint: "security add-generic-password로 저장하는 코드 추가"
  rerun_needed: true
```

**리뷰 규칙**:
- Reviewer는 항상 **ACP Codex** (구현자와 다른 모델로 cross-check)
- Reviewer는 **read-only** (코드를 직접 수정하지 않음)
- 갭 발견 시 **ACP Claude**가 수정 (리뷰어와 또 다른 모델)
- 수정 후 ACP Codex가 재리뷰
- **리뷰 루프 최대 4회** — 4회 이내 통과 못하면 Mason에게 에스컬레이션
- 모델 배정 근거: 같은 모델이 만들고 리뷰하면 같은 blind spot을 공유한다. 구현 → 리뷰 → 수정 각각 다른 모델을 써서 관점을 교차시킨다.

#### 4.6 Result Handler
**역할**: 최종 결과를 Mason에게 전달한다.

전달 내용:
- 성공: 변경 요약 + 파일 목록
- 실패 (에스컬레이션): 어디서 막혔는지 + gap 상세 + 수동 개입 필요 사항
- 자율 모드: 아침 요약 보고

---

## 5. 운영 모드

### Ask / Delegate / Autonomous (alizarion 참고)

| 모드 | 설명 | Plan 승인 | 실행 승인 | 리뷰 후 행동 |
|------|------|----------|----------|-------------|
| **Ask** | 모든 단계에서 Mason 확인 | 필요 | 필요 | Mason 판단 |
| **Delegate** | 안전한 작업은 자동, 위험한 건 확인 | 자동 (위험 시 필요) | 자동 | 통과 시 자동 커밋 |
| **Autonomous** | 전부 자동, 실패만 보고 | 자동 | 자동 | 통과 시 자동 커밋, 실패 시 보고 |

기본값: **Delegate**

위험도 판단 기준:
- 파일 삭제가 포함된 작업 → 위험
- 설정 파일(config, env, plist) 수정 → 위험
- 새 파일 생성만 → 안전
- 기존 코드 수정 (테스트 있음) → 안전
- 기존 코드 수정 (테스트 없음) → 위험

---

## 6. 포크/체리픽 맵

### 베이스: `alizarion/openclaw-claude-code-plugin`
**가져오는 것**:
- OpenClaw 플러그인 구조 (gateway 연동)
- 채널 기반 세션 관리
- Ask / Delegate / Autonomous 모드 뼈대
- 세션 시작 / 모니터링 / resume / fork 패턴
- 다중 백그라운드 세션 관리

**버리는 것**:
- Claude Code CLI 직접 호출 부분 → ACP로 교체
- 특정 모델 하드코딩 → 우리 모델 라우팅으로 교체

### Donor 1: `Chachamaru127/claude-code-harness`
**가져오는 것**:
- Plan / Work / Review / Release 루프 구조
- verb 기반 명령 인터페이스 개념
- TypeScript guardrail engine 아이디어
- parallel worker 실행 패턴

**가져오지 않는 것**:
- Claude Code 플러그인 표면 (우리는 OpenClaw 플러그인)
- 전체 스킬/에이전트 목록

### Donor 2: `SethGammon/Citadel`
**가져오는 것**:
- Router의 계층형 분류 (regex → keyword → LLM)
- circuit breaker 개념
- persistent state 관리

**가져오지 않는 것**:
- 33개 스킬 전체
- 14개 훅 전체
- campaign 시스템 전체

### Donor 3: `jkf87/openclaw-harness`
**가져오는 것**:
- 5종 gap taxonomy
- Reviewer 출력 구조
- 최대 1회 재실행 규칙
- ambiguity score 개념

**가져오지 않는 것**:
- GLM/Z.ai 모델 라우팅
- ClawHub 설치 경로

### Donor 4: `13rac1/openclaw-plugin-claude-code`
**가져오는 것**:
- 격리 실행 아이디어
- 리소스 제한 패턴
- OpenClaw 플러그인 등록 방식 참고

**가져오지 않는 것**:
- Podman/Docker 의존성 (우리는 ACP)

---

## 7. 비기능 요구사항

### 토큰 효율
- Router 판단: 최대 500 토큰
- Planner 출력: 최대 2,000 토큰
- Reviewer 출력: 최대 1,000 토큰/태스크
- Worker 결과 요약: 최대 500 토큰/태스크
- **하네스 오버헤드 합계: 태스크당 최대 ~4,000 토큰 (리뷰 1회 기준)**
- 리뷰 루프 최대 4회 시: 최대 ~8,000 토큰 추가 (리뷰 1,000 + 수정 결과 500 × 4회)

### 과잉 엔지니어링 방지 메트릭
모니터링해야 할 지표:
- **토큰 오버헤드 비율**: 하네스 토큰 / 실제 작업 토큰 (목표: < 15%)
- **false rerun rate**: 불필요한 재실행 비율 (목표: < 10%)
- **review hit rate**: 실제 갭을 잡은 비율 (목표: > 60%)
- **평균 리뷰 루프 횟수**: (목표: < 2회. 4회까지 허용하되 평균이 2 넘으면 리뷰 기준 재검토)
- **에스컬레이션 비율**: Mason에게 올라간 비율 (목표: < 20%)
- **하네스 LOC**: 전체 코드 줄 수 (경고: 2,000줄 초과 시 재검토)

### 안전
- Worker는 부모 컨텍스트에 접근 불가 (context firewall)
- Reviewer(ACP Codex)는 코드 수정 불가 (read-only)
- 리뷰 루프 최대 4회 — 초과 시 강제 에스컬레이션
- 설정 파일 변경은 Delegate 모드에서도 Mason 승인 필요

---

## 8. v1 구현 범위

### v1에서 하는 것
- [x] OpenClaw 플러그인으로 구현
- [x] Router (3단 모드 분류)
- [x] Planner (태스크 분해 + AC 정의)
- [x] Worker (ACP Codex/Claude 실행)
- [x] Reviewer (5종 gap taxonomy + 구조화된 출력)
- [x] Result Handler (보고 / 에스컬레이션)
- [x] Ask / Delegate / Autonomous 모드
- [x] 최대 1회 재실행 규칙
- [x] Telegram에서 바로 사용 가능

### v1에서 안 하는 것
- [ ] 멀티 LLM consensus
- [ ] CI/CD 자동 연동
- [ ] 커스텀 대시보드 UI
- [ ] 10개+ 병렬 Worker
- [ ] 자동 PR 생성/merge
- [ ] 브라우저 자동화 연동
- [ ] 커스텀 스킬 레지스트리

### v2에서 고려할 것
- CI/CD 연동 (GitHub Actions / PR)
- 더 정교한 모델 라우팅 (복잡도 × 카테고리)
- Worker 간 결과 공유 (discovery relay, Citadel 참고)
- 장기 캠페인 (여러 세션에 걸친 대형 프로젝트)
- 실행 히스토리 / 회고 자동화

---

## 9. 성공 기준

### v1이 성공하려면
1. **Mason이 Telegram에서 코딩 작업을 지시하면, 하네스가 자동으로 분해-실행-검토하고 결과를 돌려준다.**
2. **scope creep이나 핵심 누락을 자동으로 잡아서, Mason이 직접 리뷰하는 빈도가 줄어든다.**
3. **하네스 때문에 더 느려지거나 더 비싸지지 않는다.** (토큰 오버헤드 < 15%)
4. **"하네스 없이 하는 게 더 나았다"는 상황이 발생하지 않는다.**

---

## 10. 리서치 기반

이 PRD는 다음 조사 결과를 바탕으로 작성되었다:

### 소스 목록
| 유형 | 파일 | 내용 |
|------|------|------|
| GitHub 레포 분석 | `harness-research-repos.md` | 4개 주요 레포 딥리서치 |
| 블로그/기사 분석 | `harness-research-articles.md` | 5개 기사 핵심 추출 |
| 커뮤니티 분석 | `harness-research-community.md` | Reddit/HN 실사용 경험 |
| GitHub 후보 pass 2 | `harness-candidates-github-pass2.md` | 19개 포크 후보 |
| 커뮤니티 후보 pass 2 | `harness-candidates-community-pass2.md` | 17개 커뮤니티 후보 |
| 최종 비교 루브릭 | `harness-shortlist-pass2.md` | 9개 후보 점수화 + shortlist 5 |

### 핵심 인사이트 (크로스소스 합의)
1. **모델보다 하네스가 성능 차이를 더 크게 만든다** — LangChain Terminal Bench: +13.7%p
2. **subagent = context firewall** — 역할 분리가 아니라 컨텍스트 격리가 핵심
3. **하네스는 작고 모듈형이어야 한다** — 커뮤니티 최강 컨센서스
4. **제약이 곧 신뢰성** — 가드레일이 많을수록 에이전트가 더 잘 작동
5. **실패할 때만 엔지니어링하라** — 사전 최적화보다 실패 대응형 반복이 효과적

---

_이 문서는 구현 시작 전에 Mason의 리뷰를 받기 위한 초안이다._
_구현 후 실제 동작과 달라지는 부분이 있으면 이 문서를 업데이트한다._
# Appendix — 포크 구조 분석 + 구현 가이드 (PRD v1.2)

---

## A. 포크 베이스 구조 분석: `alizarion/openclaw-claude-code-plugin`

### A.1 레포 개요
- **총 코드**: ~6,624줄 (TypeScript)
- **구조**: OpenClaw 플러그인 표준 형식
- **핵심 파일 12개** + docs/skills

### A.2 파일 맵

```
openclaw-claude-code-plugin/
├── openclaw.plugin.json     ← 플러그인 메타데이터/설정 스키마
├── index.ts                 ← 엔트리포인트: 도구 8개 + 커맨드 8개 + RPC 5개 + 서비스 1개 등록
├── package.json
│
├── src/
│   ├── types.ts             (120줄) ← 타입 정의. SessionConfig, PluginConfig 등
│   ├── shared.ts            (281줄) ← 전역 상태 (sessionManager, pluginConfig 등)
│   ├── session.ts           (480줄) ← 단일 CC 세션 래퍼. PTY 프로세스 관리
│   ├── session-manager.ts   (666줄) ← 세션 라이프사이클. spawn/kill/resume/fork/GC
│   ├── notifications.ts     (380줄) ← 채널 기반 알림 라우팅
│   ├── gateway.ts           (185줄) ← Gateway RPC (외부 API)
│   │
│   ├── tools/               ← 에이전트에게 노출되는 도구 (tool)
│   │   ├── claude-launch.ts    (498줄) ← 핵심. 세션 시작
│   │   ├── claude-fg.ts        (126줄) ← 포그라운드 전환
│   │   ├── claude-bg.ts        (129줄) ← 백그라운드 전환
│   │   ├── claude-respond.ts   (180줄) ← 멀티턴 응답
│   │   ├── claude-output.ts    (90줄)  ← 출력 조회
│   │   ├── claude-sessions.ts  (90줄)  ← 세션 목록
│   │   ├── claude-kill.ts      (65줄)  ← 세션 종료
│   │   └── claude-stats.ts     (31줄)  ← 메트릭
│   │
│   └── commands/            ← 슬래시 커맨드 (/claude, /claude-sessions 등)
│       └── (8개 파일, 대부분 tool의 CLI wrapper)
│
├── skills/
│   └── claude-code-orchestration/
│       └── SKILL.md         ← 에이전트용 사용 가이드 (안티패턴 포함)
│
└── docs/
    ├── ARCHITECTURE.md
    ├── NOTIFICATIONS.md
    ├── AGENT_CHANNELS.md
    ├── safety.md
    ├── tools.md
    └── DEVELOPMENT.md
```

### A.3 핵심 설계 패턴

#### 도구(tool) = 에이전트가 호출하는 함수
OpenClaw가 플러그인을 로드하면, 에이전트에게 `claude_launch`, `claude_sessions` 등의 **새 도구**가 생긴다.
에이전트가 이 도구를 호출하면 플러그인 코드가 실행된다.

#### 서비스(service) = gateway 안에서 상주하는 프로세스
`start()` 시 SessionManager + NotificationRouter 생성.
`stop()` 시 모든 세션 kill + cleanup.

#### 세션 = Claude Code PTY 프로세스 래퍼
`session.ts`가 `@anthropic-ai/claude-agent-sdk`로 CC 프로세스를 spawn.
출력 버퍼링, waiting-for-input 감지, 멀티턴 대화를 관리.

#### 알림 라우팅
`agentChannels` config로 workdir → 채널 매핑.
세션 상태 변경 시 해당 채널로 알림 (`openclaw message send` CLI).

### A.4 남길 것 / 버릴 것 / 바꿀 것

| 파일/모듈 | 판정 | 이유 |
|-----------|------|------|
| `openclaw.plugin.json` | **남기고 수정** | 플러그인 ID/이름/설정 스키마를 harness용으로 변경 |
| `index.ts` | **남기고 수정** | 도구 등록 구조 유지. 도구 이름/개수를 harness용으로 변경 |
| `src/types.ts` | **남기고 확장** | HarnessConfig, ReviewResult, GapType 등 추가 |
| `src/shared.ts` | **남기고 수정** | harness 전역 상태 추가 |
| `src/session.ts` | **핵심 수정** | CC PTY 대신 ACP spawn으로 교체. 이게 제일 큰 변경 |
| `src/session-manager.ts` | **핵심 수정** | Plan/Work/Review 루프 로직 추가. Checkpoint 추가 |
| `src/notifications.ts` | **대부분 유지** | 채널 라우팅 그대로 쓸 수 있음 |
| `src/gateway.ts` | **유지** | RPC API 구조 그대로 |
| `src/tools/claude-launch.ts` | **핵심 수정** | → `harness-execute.ts`. Router + Dispatcher 로직 |
| `src/tools/claude-output.ts` | **유지** | → 세션 결과 조회 |
| `src/tools/claude-sessions.ts` | **유지** | → 하네스 세션 목록 |
| `src/tools/claude-kill.ts` | **유지** | → 하네스 세션 종료 |
| `src/tools/claude-respond.ts` | **유지** | → 멀티턴 응답 (Ask 모드에서 Mason 응답 시) |
| `src/tools/claude-fg.ts` | **유지** | 포그라운드 전환 |
| `src/tools/claude-bg.ts` | **유지** | 백그라운드 전환 |
| `src/tools/claude-stats.ts` | **확장** | 하네스 메트릭 추가 |
| `src/commands/*` | **이름 변경** | `/claude` → `/harness` 계열로 |
| `skills/SKILL.md` | **다시 작성** | harness orchestration 가이드로 |
| `docs/*` | **유지 + 추가** | harness 아키텍처 문서 추가 |

### A.5 새로 만들어야 할 것

| 파일 | 역할 | 예상 줄 수 |
|------|------|-----------|
| `src/router.ts` | 요청 복잡도 판단, tier 0/1/2 분류 | ~150줄 |
| `src/planner.ts` | 태스크 분해, acceptance criteria 생성 | ~200줄 |
| `src/reviewer.ts` | ACP Codex로 리뷰, 5종 gap taxonomy 판정 | ~250줄 |
| `src/review-loop.ts` | 리뷰 → ACP Claude 수정 → 재리뷰 (최대 4회) | ~200줄 |
| `src/checkpoint.ts` | 태스크 단위 상태 저장/복원 | ~150줄 |
| `src/gap-types.ts` | gap taxonomy 정의 + 판정 프롬프트 | ~80줄 |

**예상 신규 코드: ~1,030줄**
**기존 코드 수정: ~800줄**
**총 예상: 기존 6,624줄 + 신규 ~1,030줄 - 삭제 ~500줄 ≈ ~7,150줄**

---

## B. Donor 체리픽 구체 맵

### B.1 openclaw-harness → gap taxonomy
**가져올 것**: 5종 갭 분류 정의 + Reviewer 프롬프트 구조
**적용 위치**: `src/gap-types.ts`, `src/reviewer.ts`
**방식**: 코드 복사가 아니라 개념 이식 (원본이 README 중심이라 실행 코드가 적음)

### B.2 claude-code-harness → Plan/Work/Review 루프
**가져올 것**: 5 verb 인터페이스 개념 (setup/plan/work/review/release)
**적용 위치**: `src/router.ts`, `src/planner.ts`, `src/review-loop.ts`
**방식**: 구조 참고. TypeScript guardrail engine 아이디어는 reviewer에 반영

### B.3 Citadel → Router 계층
**가져올 것**: 0-token regex → keyword → LLM 3단 라우팅
**적용 위치**: `src/router.ts`
**방식**: 패턴 매치 / 키워드 / LLM 분류 계층 구조 이식

### B.4 Nova 피드백 → Checkpoint + Memory V3
**가져올 것**: 태스크 단위 상태 저장, Memory V3 검색 통합
**적용 위치**: `src/checkpoint.ts`, `src/planner.ts`

---

## C. CC Interactive 구현 가이드

### C.1 사전 준비
```bash
# 1. 포크 clone
cd ~/projects
git clone https://github.com/alizarion/openclaw-claude-code-plugin.git openclaw-harness
cd openclaw-harness

# 2. 의존성 설치
npm install

# 3. PRD 파일 복사 (CC가 참고하도록)
cp /Users/nova/.openclaw/workspace-sol/harness-prd.md ./PRD.md
cp /Users/nova/.openclaw/workspace-sol/harness-prd-appendix.md ./PRD-APPENDIX.md
```

### C.2 구현 순서 (추천)

#### Phase 1: 뼈대 (1~2시간)
1. `openclaw.plugin.json` 수정 — ID, 이름, 설정 스키마
2. `index.ts` 수정 — 도구 이름 변경 (`claude_*` → `harness_*`)
3. `src/types.ts` 확장 — HarnessConfig, GapType, ReviewResult 타입
4. `src/gap-types.ts` 신규 — 5종 gap taxonomy 정의

#### Phase 2: Router + Planner (1~2시간)
5. `src/router.ts` 신규 — tier 0/1/2 분류
6. `src/planner.ts` 신규 — 태스크 분해 (ACP 또는 내장 LLM 호출)

#### Phase 3: Worker 교체 (2~3시간)
7. `src/session.ts` 수정 — CC PTY → ACP spawn으로 교체
8. `src/session-manager.ts` 수정 — harness 루프 통합
9. `src/tools/claude-launch.ts` → `src/tools/harness-execute.ts` — Router + Dispatcher

#### Phase 4: Reviewer + Review Loop (2~3시간)
10. `src/reviewer.ts` 신규 — ACP Codex 리뷰 + gap taxonomy
11. `src/review-loop.ts` 신규 — 리뷰 → ACP Claude 수정 → 재리뷰 (4회)
12. `src/checkpoint.ts` 신규 — 태스크 상태 저장/복원

#### Phase 5: 통합 + 테스트 (1~2시간)
13. 전체 루프 연결 (Router → Planner → Worker → Reviewer → Result)
14. `skills/SKILL.md` 다시 작성
15. 로컬 테스트: `openclaw plugins install ./openclaw-harness`

### C.3 CC에 넣을 CLAUDE.md 핵심 규칙
```markdown
# CLAUDE.md for OpenClaw Harness

## 이 프로젝트가 뭔지
OpenClaw 플러그인. 코딩 작업을 Plan→Work→Review 루프로 자동화한다.
`alizarion/openclaw-claude-code-plugin`을 포크해서 만든다.

## 반드시 지킬 것
- PRD.md와 PRD-APPENDIX.md를 읽고 따를 것
- 기존 플러그인 구조(도구/서비스/알림)를 유지할 것
- CC PTY 대신 ACP spawn(`sessions_spawn`)을 실행 엔진으로 쓸 것
- 리뷰는 항상 ACP Codex, 수정은 항상 ACP Claude
- 리뷰 루프 최대 4회
- gap taxonomy 5종: assumption_injection, scope_creep, direction_drift, missing_core, over_engineering
- 새 파일은 src/ 아래에 TypeScript로

## 건드리면 안 되는 것
- `src/notifications.ts` 구조 (알림 라우팅)
- `src/gateway.ts` 구조 (RPC API)
- OpenClaw 플러그인 등록 패턴 (`api.registerTool`, `api.registerService`)
```

---

_이 부록은 PRD v1.2의 일부로, 본문(harness-prd.md)과 함께 읽는다._
