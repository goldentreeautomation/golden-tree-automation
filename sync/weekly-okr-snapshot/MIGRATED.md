# ⚠️ MIGRATED / LEGACY / ROLLBACK REFERENCE / DO NOT EDIT

이 Edge Function은 **Business OS(`goldentreeautomation/business-os`)로 이전 완료**됐고,
2026-09-10 production cutover program에서 Business OS 버전이 production에 배포됐다.

- **Canonical source (지금 수정할 곳):** `business-os/supabase/functions/weekly-okr-snapshot`
  (+ 순수 로직은 `business-os/packages/*`)
- **이 디렉터리(`golden-tree-automation/sync/weekly-okr-snapshot/`):** rollback 참조용으로만 보존. **수정 금지.**
  두 저장소에서 같은 함수를 동시에 고치면 안 된다.
- production 배포: `weekly-okr-snapshot` = Business OS v11
- 이전 근거·검증: `business-os/docs/migration/0003-function-cutover-registry.md`
  (2026-09-10 production cutover program 섹션)

rollback이 필요하면 change window 시점 배포 소스(registry 문서 + 별도 보관)를
`supabase functions deploy weekly-okr-snapshot` 또는 Management API PATCH로 재배포한다.
