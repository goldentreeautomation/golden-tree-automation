# ⚠️ MIGRATED / LEGACY / DO NOT EDIT

이 Edge Function은 **Business OS(`goldentreeautomation/business-os`)로 이전 완료**됐고,
2026-09-10 production change window에서 Business OS 버전이 production에 배포됐다.

- **Canonical source (지금 수정할 곳):** `business-os/supabase/functions/publish-web/`
  (+ 순수 로직은 `business-os/packages/business-rules`, 브랜드 상수는 `business-os/packages/config`)
- **이 디렉터리(`golden-tree-automation/web/publish-web/`):** rollback 참조용으로만 보존. **수정 금지.**
  두 저장소에서 같은 함수를 동시에 고치면 안 된다.
- 이전 근거·검증: `business-os/docs/migration/0003-function-cutover-registry.md`,
  `business-os/docs/architecture/edge-function-migration-pattern.md`

rollback이 필요하면 이 디렉터리의 `src/index.ts`를 Supabase에 재배포하면 된다
(change window 시점 배포 버전은 registry 문서에 기록).
