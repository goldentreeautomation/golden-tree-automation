# tiktok-oauth — 소스 회수 기록 (2026-09-10)

## 배경

이 Edge Function은 production Supabase(`stfiazhmznssyfsiaxvw`)에 **버전 14, ACTIVE 상태로
배포돼 있었으나, 이 저장소를 포함한 어떤 Git 저장소에도 소스가 없었다.** Business OS
이전 준비 중 전체 Edge Function을 조사하다 발견했다(`business-os/docs/migration/0002`).

배포는 돼 있는데 버전 관리·PR 리뷰·diff 이력이 전혀 없는 상태 = 거버넌스 공백. 이
커밋은 **동작을 하나도 바꾸지 않고**, 현재 배포된 소스를 그대로 회수해 버전 관리에
편입하는 것만 목적으로 한다.

## Provenance (출처)

- 회수 방법: Supabase Management API `GET /v1/projects/{ref}/functions/tiktok-oauth`
  (MCP `get_edge_function`)의 `files[0].content` 를 그대로 저장.
- 회수 시점 배포 버전: **v14** (`updated_at` = 1786685671499, `ezbr_sha256` =
  `34db53b76fa685286c344312ae2944b503c0d17e89cfab3af29d7afbd9e2f37e`).
- `src/index.ts`는 회수한 내용 그대로다 — 포맷·정리 안 함(파일 앞부분에 Supabase "새
  함수" 템플릿(`withSupabase` 기반 Hello 예제)이 그대로 남아 있고 그 뒤에 실제 구현이
  이어붙어 있다. `Deno.serve(...)`가 서버를 띄우므로 앞의 `export default { fetch: ... }`는
  실행되지 않는 죽은 코드다. 회수 충실성을 위해 그대로 뒀다).

## Secret 검사 (커밋 전)

하드코딩된 secret/token/API credential **없음**. 모든 비밀값은 `Deno.env.get()`으로 읽는다:
`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_BROKER_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. refresh token은 전부 DB(`tiktok_oauth_tokens`)에서
읽고 코드에 없다. 하드코딩된 URL은 공개 TikTok API 엔드포인트뿐이다.

## 현재 상태

- `tiktok_oauth_tokens` 테이블: **0 행** (지금 연결된 TikTok 계정 없음).
- `tiktok_oauth_states` 테이블: 소수의 transient 행.
- 이 함수는 아직 Business OS로 이전하지 않았다 — CUTOVER-LATE 분류. 실제 OAuth
  redirect_uri가 이 함수 URL을 가리키고 있어, 이전 시 redirect 흐름이 깨지지 않도록
  신중히 다뤄야 한다.

## 하는 일

`start`(OAuth 시작 → TikTok authorize로 302), `callback`(code 교환 → 토큰 저장),
`status`(연결 상태 조회, `x-broker-key` 필요), `sync`(토큰 갱신 + user info/video list 조회,
`x-broker-key` 필요).
