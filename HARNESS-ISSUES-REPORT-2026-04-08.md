# OpenClaw Harness 이슈 보고서

작성일: 2026-04-08
대상: OpenClaw harness realtime / review ownership / launcher / reviewer helper

## 한 줄 요약
지금 하네스 문제의 중심은 단순히 버그가 여러 개 흩어진 게 아니라, `remote realtime → waiting checkpoint → Codex review owner → local/remote sync` 경계가 여러 층으로 나뉘어 있는데 그 ownership이 한동안 transient turn에 묶여 있었고, 그걸 durable owner로 옮기는 과정에서 경로/동기화/런처 문제가 연쇄로 드러난 상태예요.

## 현재 상태
- `openclaw-harness` 작업 체크포인트는 아직 `running`이며, 완료 단계는 `6/7`로 기록돼 있어요 [source: /Users/nova/projects/openclaw-harness/checkpoint.json].
- 다음 액션은 `implementation waiting`의 Codex 리뷰 ownership을 transient caller turn에서 durable job-bound continuation으로 옮기는 것으로 적혀 있어요 [source: /Users/nova/projects/openclaw-harness/checkpoint.json].
- 최신 fresh smoke `rt-20260408-171526`는 `implementation-review.log`를 생성했기 때문에, Mac Mini에서 durable helper가 실제로 기동되기 시작한 것까지는 확인됐어요 [source: /tmp/claude-realtime/rt-20260408-171526/implementation-review.log].
- 다만 그 helper가 Hetzner 경로를 Mac Mini 로컬 경로처럼 사용해서 즉시 실패했고, 현재 남은 핵심 blocker는 바로 그 path translation 문제예요 [source: /tmp/claude-realtime/rt-20260408-171526/implementation-review.log].

## 확인된 문제 목록

### 1) implementation `waiting` 리뷰 ownership이 transient harness turn에 묶여 있었음
**증상**
- Claude Code 구현은 끝났는데 최종 `DONE` 피드백이 기록되지 않아 job이 orphaned `waiting` 또는 최종 `error`로 남았어요.
- 대표적으로 `harness-plan-20260408-ti5q1j-task-1-1775631987355`는 `result-2.json`에 성공 결과가 있지만 최종 reviewer artifact가 없고 결국 `error` 상태가 됐어요 [source: /tmp/claude-realtime/harness-plan-20260408-ti5q1j-task-1-1775631987355/result-2.json, /tmp/claude-realtime/harness-plan-20260408-ti5q1j-task-1-1775631987355/status].

**원인 판단**
- `plan_waiting`은 caller agent가 review해야 하고, implementation `waiting`은 Codex가 review해야 하는데, 후자가 durable owner가 아니라 transient plugin/harness turn 수명에 기대고 있었어요.
- 그래서 parent turn이 끊기면 구현은 끝났어도 review continuation이 사라졌어요.

**상태**
- 원인 규명 완료.
- ownership을 shell/job 계층으로 내리는 방향으로 수정 중.

---

### 2) remote `waiting`에서 Codex helper를 잘못된 실행 위치에서 띄우던 문제
**증상**
- Hetzner에서 `waiting`에 들어가도 implementation review가 시작되지 않았어요.
- `implementation-review.log`, `implementation-review-round-*.source.txt` 같은 artifact가 생기지 않는 job이 있었어요.

**원인 판단**
- Hetzner에서 실행되는 `claude-realtime.sh`가 implementation review 시 `bash "$SCRIPT_DIR/cc-implementation-review.sh" ...` 형태로 helper를 직접 띄우고 있었어요 [source: /Users/nova/.openclaw/workspace-nova/scripts/claude-realtime.sh].
- 그런데 Codex review owner는 Hetzner가 아니라 Mac Mini 쪽 durable helper여야 했어요.

**적용된 수정**
- 현재 `claude-realtime.sh`는 implementation `waiting` 시 Mac Mini(`100.66.20.53`)로 SSH back 해서 `~/.local/bin/cc-implementation-review.sh`를 띄우도록 바뀌었어요 [source: /Users/nova/.openclaw/workspace-nova/scripts/claude-realtime.sh].
- `~/.local/bin/cc-implementation-review.sh` symlink도 생성돼 있어요 [source: /Users/nova/.local/bin/cc-implementation-review.sh].

**상태**
- 이 단계는 일부 해결.
- 이제 helper 자체는 뜨기 시작했어요.

---

### 3) durable helper가 remote workdir를 local workdir로 오해하는 path translation 버그
**증상**
- fresh smoke `rt-20260408-171526`에서 helper는 시작됐지만 즉시 아래 에러로 죽었어요.
- `/Users/nova/.local/bin/git-sync.sh: line 39: cd: /home/nova/projects/openclaw-harness-codex-owner-smoke-v2: No such file or directory` [source: /tmp/claude-realtime/rt-20260408-171526/implementation-review.log]

**원인 판단**
- Hetzner의 `claude-realtime.sh`가 Mac Mini helper 호출 시 `WORKDIR` 인자로 Hetzner 경로(`/home/nova/projects/...`)를 넘기고 있어요 [source: /Users/nova/.openclaw/workspace-nova/scripts/claude-realtime.sh].
- 그런데 `cc-implementation-review.sh`는 그 값을 그대로 `git-sync.sh pull "$WORKDIR"`에 사용해 Mac Mini 로컬 경로처럼 취급해요 [source: /Users/nova/.openclaw/workspace-nova/scripts/cc-implementation-review.sh].
- 그래서 helper 기동은 성공했지만 실제 review 준비 단계에서 실패해요.

**상태**
- 현재 최우선 미해결 blocker.

**권장 수정**
- remote worker가 아는 Hetzner 경로와, origin launcher가 아는 Mac Mini 로컬 경로를 분리해서 전달해야 해요.
- 가장 안전한 방법은 launch 시점에 `ORIGINAL_WORKDIR`를 별도 상태 파일 또는 env로 저장하고, Mac Mini helper는 그 값을 사용하게 하는 거예요.

---

### 4) remote state sync 누락으로 local reviewer가 결과를 못 보던 문제
**증상**
- 구현 결과가 remote state에는 있어도 local state dir에는 반영되지 않아 Codex review가 `No realtime result found` 류로 실패했어요.

**원인 판단**
- implementation review helper가 prompt를 만들기 전에 필요한 `result-$ROUND.json`, `stream-$ROUND.jsonl`, 기타 state 파일을 충분히 local로 동기화하지 못했어요.

**적용된 수정**
- 현재 helper는 시작 직후와 `git-sync pull` 이후에 `scp -q -r "$REMOTE_HOST:$STATE_DIR/." "$STATE_DIR/"`를 수행해 remote state를 local로 끌어오게 돼 있어요 [source: /Users/nova/.openclaw/workspace-nova/scripts/cc-implementation-review.sh].

**상태**
- 구조적으로는 보강됨.
- 다만 현재는 path translation 버그가 더 앞단에서 helper를 죽이고 있어서 end-to-end 완전 검증은 아직 미완료예요.

---

### 5) helper 내부 구현 실수: `mkdirSync is not defined`
**증상**
- 중간 smoke 중 하나가 `mkdirSync is not defined`로 실패했어요.

**원인 판단**
- helper/related runtime에서 필요한 import가 빠져 있었어요.

**상태**
- 이미 수정된 이슈로 분류.
- 현재 남아 있는 blocker는 이 문제가 아니에요.

---

### 6) `CLAUDE.md` 부재 시 realtime launch가 비정상 상태에 머물던 문제
**증상**
- 프로젝트 컨텍스트가 없는 repo에서도 realtime launch가 시도됐고, 실패해도 `launching` 같은 중간 상태에 남을 수 있었어요.

**적용된 수정**
- `harness_execute.ts`는 realtime worker launch 전에 `CLAUDE.md` 또는 `.claude/CLAUDE.md` 존재를 강제해요 [source: /Users/nova/projects/openclaw-harness/src/tools/harness-execute.ts].
- missing 시 `Missing CLAUDE.md (or .claude/CLAUDE.md).` 에러를 던지도록 되어 있어요 [source: /Users/nova/projects/openclaw-harness/src/tools/harness-execute.ts].

**상태**
- 해결됨.

---

### 7) review loop 한도가 낮아서 회귀 수정 반복에 취약했던 문제
**증상**
- review/fix/rereview loop 허용치가 작아서 조금만 꼬여도 너무 빨리 escalation될 수 있었어요.

**적용된 수정**
- 기본 `maxReviewLoops`가 `10`으로 설정돼 있어요 [source: /Users/nova/projects/openclaw-harness/src/shared.ts].
- `review-loop.ts`도 같은 전제에 맞춰 동작해요 [source: /Users/nova/projects/openclaw-harness/src/review-loop.ts].

**상태**
- 해결됨.

---

### 8) `reviewOnly` lane 부재로 로컬 변경만 재검토하기 어려웠던 문제
**증상**
- planner/worker를 다시 태우지 않고 이미 존재하는 로컬 변경만 reviewer에 태우는 경로가 부족했어요.

**적용된 수정**
- `harness_execute`는 `reviewOnly` 파라미터를 받도록 확장됐고, 그 경로가 구현돼 있어요 [source: /Users/nova/projects/openclaw-harness/src/tools/harness-execute.ts].

**상태**
- 해결됨.

---

### 9) stale old job이 최신 수정 검증을 오염시키는 운영 문제
**증상**
- 이미 broken path로 시작된 old job을 계속 열어보면, 최신 수정이 반영됐는지 판단이 흐려져요.
- 예를 들어 `ti5q1j`는 지금 봐도 `error`지만, 이 job 자체는 최신 path translation fix 전 history를 포함하고 있어서 최신 end-to-end health를 대표하지 못해요 [source: /tmp/claude-realtime/harness-plan-20260408-ti5q1j-task-1-1775631987355/status].

**상태**
- 운영상 주의사항.
- 검증은 항상 fresh job 기준으로 해야 해요.

---

### 10) approval / automatic session resume 경로의 별도 UX 버그
**증상**
- `/approve`가 이미 만료된 id에 대해 `unknown or expired approval id`를 내거나, 승인 후 `Automatic session resume failed`로 raw 상태만 채팅에 뜨는 현상이 있었어요.

**판단**
- 이건 implementation waiting ownership 문제와는 별개예요.
- 하지만 하네스 디버깅 중 사용자 경험을 크게 망치므로 같이 추적해야 해요.

**상태**
- 별도 control-plane 이슈로 남김.

## 이번에 실제로 바뀐 표면

### live runtime scripts
- `/Users/nova/.openclaw/workspace-nova/scripts/claude-realtime.sh`
- `/Users/nova/.openclaw/workspace-nova/scripts/cc-implementation-review.sh`
- `/Users/nova/.local/bin/cc-implementation-review.sh` → symlink 생성 [source: /Users/nova/.local/bin/cc-implementation-review.sh]

### harness repo working tree
현재 `openclaw-harness` working tree에는 아래 파일 수정이 남아 있어요 [source: git status probe in /Users/nova/projects/openclaw-harness].
- `README.md`
- `dist/index.js`
- `docs/ARCHITECTURE.md`
- `scripts/run-tests.js`
- `src/review-loop.ts`
- `src/shared.ts`
- `src/tools/harness-execute.ts`
- `checkpoint.json` 신규

## 지금 기준으로 분류한 상태

### 해결된 것
- `CLAUDE.md` 사전 강제
- `reviewOnly` lane 추가
- review loop 기본치 상향
- implementation review helper를 Mac Mini durable owner로 연결하는 SSH-back 구조 시작

### 부분 해결된 것
- remote state sync 보강
- implementation review owner를 transient turn 밖으로 빼는 구조

### 아직 안 끝난 것
- Mac Mini helper의 local workdir 결정 방식
- fresh smoke에서 `waiting -> Codex review -> DONE` 완주 검증
- old/stale job noise 정리
- approval/resume UX 버그 분리 추적

## 추천 우선순위
1. `cc-implementation-review.sh`가 Mac Mini 로컬 workdir를 정확히 찾도록 수정
2. fresh smoke를 다시 실행해 `implementation-review-round-*.source.txt`에 `source=codex-cli`가 남는지 확인
3. 그 다음 `feedback`가 remote state로 돌아가고, Hetzner worker가 `DONE` 또는 `REVISE`를 소비해 진행하는지 확인
4. 성공하면 `checkpoint.json`을 `complete`로 갱신
5. 마지막으로 commit 정리

## 결론
지금 하네스는 완전히 무너진 상태는 아니고, 중요한 축 하나는 이미 좁혀졌어요.

- 전에는 implementation review helper가 아예 durable owner로 붙지 못했어요.
- 지금은 helper가 실제로 Mac Mini에서 기동되는 것까지는 확인됐어요.
- 남은 본체 blocker는 `remote path`와 `local path`를 혼동하는 마지막 연결부예요.

즉, 현재 상태는 "원인 미상 다중 장애"가 아니라, **ownership 이동은 성공했고 마지막 path translation 버그 하나가 end-to-end completion을 막고 있는 단계**로 보는 게 가장 정확해요.
