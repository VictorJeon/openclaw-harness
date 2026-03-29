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
