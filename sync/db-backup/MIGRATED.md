# ⚠️ MIGRATED / LEGACY / ROLLBACK REFERENCE / DO NOT EDIT

이 Edge Function은 **Business OS(`goldentreeautomation/business-os`)로 이전 완료**됐고,
2026-09-10 production cutover program에서 restore drill 통과 후 Business OS 버전이
production에 배포됐다(`db-backup` = Business OS v8).

- **Canonical source (지금 수정할 곳):** `business-os/supabase/functions/db-backup/`
  (+ 순수 로직 `business-os/packages/business-rules/db-backup.ts`, 테이블 목록
  `business-os/packages/config/src/backup.ts`)
- **이 디렉터리(`golden-tree-automation/sync/db-backup/`):** rollback 참조용으로만 보존.
  **수정 금지.**
- pg_cron job 3개(`db-backup-automation-weekly` 월/수/금 10:00,
  `db-backup-local-growth-weekly` 일 10:30, `db-backup-monthly-verify` 매월 1일 11:00)는
  같은 `db-backup` 슬러그를 `public.call_edge_function()`(Vault) 경유로 호출 →
  자동으로 새 코드를 쓴다. cron job 자체는 바뀐 게 없다.
- restore drill: `business-os/scripts/db-restore-drill.ts` (2026-09-10 PASS 7/FAIL 0)
- 이전 근거·검증: `business-os/docs/migration/0003-function-cutover-registry.md`,
  `business-os/docs/runbooks/db-backup.md`

rollback: 이 디렉터리의 소스를 `supabase functions deploy db-backup`으로 재배포.
