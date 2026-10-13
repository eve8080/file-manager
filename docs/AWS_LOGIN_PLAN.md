# S3 File Manager：揀 Google 或 Email 登入，最終批准稿

**狀態：** Mr. So 已批准 Phase A（開始：「批准開始Phase A」；繼續：2026-10-13「ok, please proceed phase A」）。Phase A 本地部分喺 2026-10-11 test-first 實作（brief D26），2026-10-13 完成實作者 self-audit（唔係獨立 review），同日再做咗獲批嘅 close-out round；證據、指令同測試數字喺 `docs/HANDOFF.md`。驗證**只係離線**：真 `aws-jwt-verify` 驗合成 Cognito 格式 token（離線 JWKS），真 `oidc-client-ts` 喺 headless Chrome 對本地 fake Cognito login。真 Cognito/Google、MFA、account link、公司網絡、手機同真 S3 **全部未測**。Phase B、Phase C 仍然未批。獨立 review 嘅結論記錄喺 `docs/CLAUDE_REVIEW.md`。下面第 0–7 節係批准前嘅規劃稿（歷史記錄）；Phase A 實際做法見第 3 節尾嘅「Phase A 實作結果」。

> 核實記錄：Claude Code Opus 完成文件研究及修訂；Hermes 另外直接擷取、檢查本稿全部 21 個列明來源。文件支持架構方向，唔代表已做 integration/runtime 驗證。之前 scratch 報告聲稱「40 個來源已獨立核實」嘅說法已撤回，唔係本稿證據。
> Phase A 已批准並喺本地實作（離線驗證）。2026-10-11 一個早期 startup test 有冇讀取本機 AWS 配置或者對外連線係 UNKNOWN，之後嘅隔離測試唔能夠證明當時冇發生；現時所有 real-server 測試同 in-process presign 都已隔離（詳見 `docs/HANDOFF.md`）。Phase B、Phase C 仍然未批。公司 network、真 Cognito/Google、AWS origin/payload 同實機測試未做。
> 建議 hosting 保持 CloudFront + 私人 S3 frontend origin + Lambda Function URL（OAC/IAM）+ 私人 S3 data bucket；獨立 frontend bucket 及新服務仍需批准，唔修改現有單一 data bucket 規則。
> Hermes 只修正咗兩個文件表述：保留 1 MiB 文字預覽上限，以及只清除登入交易嘅 sessionStorage entries。

## 0. 執行結論

- **建議而家只批 Phase A（本地）：** 跑 baseline、加 auth middleware、做兩個選擇嘅登入 UI 同測試。
- **Phase B 之後另外批：** 雲端 100 MiB 直傳 S3、Lambda 打包、6 MB transport gate。
- **Phase C 之後另外批：** 開 AWS/Google 資源、部署。
- 現有冇登入嘅本地 v1（D1/D2）喺 migration 批准之前**完全唔變**。

## 1. 已批准嘅需求 vs 建議實作

**已批准嘅需求（brief 入面寫咗）：**
- 登入畫面有兩個選擇：「Continue with Google」同「Email + password」。
- Email 路徑唔可以依賴 Google。
- 兩種登入都要對應同一個 owner 身份。
- 唔准公開註冊，唔可以單憑 email 相同就自動 link。
- Agent 用自己獨立嘅身份。
- 公司網絡只係驗收條件，唔係保證。

**建議嘅實作：**
- Cognito user pool，開兩個 public app client（冇 secret，用 PKCE）。
- Backend 用 `aws-jwt-verify` 驗 access token，再用固定 `sub` allowlist 做授權。
- Browser 用 `oidc-client-ts` 處理 OIDC。

## 2. 登入同帳戶設計

**兩個入口**（S1 有官方支持 `identity_provider=COGNITO`）：
- Email 入口：`/oauth2/authorize?…&client_id=<native-client>&identity_provider=COGNITO`。呢個 client 只開 `COGNITO`。
- Google 入口：`…&client_id=<google-client>&identity_provider=Google`。呢個 client 只開 `Google`。
- Email 頁面會唔會載入 Google 資源，**要 runtime 驗**。
- 登入出錯或取消，返回 chooser。
- Google 嘅 redirect URI 係 Cognito 嘅 `/oauth2/idpresponse`，**唔係** app callback（S6）。scope 只用 `openid email profile`。
- Google 嘅 test user 名單**唔係**存取控制：用基本 scope 時根本唔使列名（S6）。

**授權**
- Google 用戶第一次登入，即使冇 link 都會自動開 profile（S7）。所以 Cognito 登入成功**唔等於**有權限。
- API 只接受 `OWNER_SUBS` 入面精確嘅 native owner `sub`，或者 `AGENT_CLIENTS` 入面嘅 client_id 加對應 scope。冇任何基於 email 嘅升權。

**帳戶 link（Phase C 嘅 runbook）**
1. 先開 native owner，用實際 username 做 Destination（S2）。
2. 喺 owner 第一次 Google 登入**之前**，用可信方法取得佢嘅 Google `sub`。
3. 叫 `AdminLinkProviderForUser`，Source 用 `Google` / `Cognito_Subject` / 該 `sub`（S2/S7）。**唔准用 email 自動 merge**。
4. 如果已經用 Google 登入過，就要先刪除舊 profile（S7）。**呢步要另外批准破壞性操作**，而家唔建議做。

**Email attribute 同 recovery（Phase C 前提）**
- Link 咗之後，每次 Google 登入都會將 mapped claims 寫入 owner profile（S7）。
- Required attribute、mutable 設定、email mapping 同 recovery 點樣配合，要等 schema 有官方支持先定，屆時要批准一個已驗證嘅 email 設定。唔假設用現有個人郵箱。
- 如果 recovery 郵箱由 Google 提供，email 路徑嘅重設密碼就會依賴 Google。呢個要喺公司網絡實測，唔代表一定用唔到。

**MFA**
- Native 建議：MFA required、只開 TOTP（S3）。
- Recovery 用乜方法遲啲先揀；如果揀 email，就唔可以同時開 email MFA（S3）。
- 新用戶第一次登入可能未做 MFA 都攞到 token（S3），所以開戶時要即刻完成 TOTP 設定。
- **Google 路徑冇 Cognito MFA**（S3），只能靠 Google 帳戶自己嘅 2SV。

**Logout 同撤銷**
- Logout 做三件事：清走記憶體嘅 token、revoke refresh token、轉去 Cognito `/logout`。
- `/logout` 本身**唔會**撤銷 token，亦**唔會**登出 Google（S17）。
- Revoke 之後，本地 JWT library 驗證仍然會當 token 有效，直到到期（S16）。
- 改 allowlist 唔係「即時全球生效」：舊環境同 config 傳播要實際量度。
- Public client 冇 secret。

**M2M 收費**
- 現行收費頁寫明「only per successful token response」，app client 數目唔另外收費（S15）。
- Developer guide 仍然寫「active clients + volume」（S10），兩份文件矛盾。以收費頁為準，唔估數字。

## 3. Phase A：建議批准嘅範圍

**新 dependency（批准後先揀版本，lockfile 同 artifact 都要有證明）：**
- `aws-jwt-verify`（S11）：0 個 runtime dependency，可以查 iss、token_use、clientId array、scope，有 `customJwtCheck`。
- `oidc-client-ts`（S19/S20）：支援 code + PKCE、refresh，有 session 同 token 管理。
  - 發佈包有 `dist/umd`、`dist/esm`，有一個 transitive dependency：`jwt-decode`（只 decode，唔驗簽名）。
  - 要將固定版本嘅 browser bundle 放喺同一 origin serve，**唔用 CDN**。安裝後要檢查實際 release，先確認可唔可以直接載入，唔預先保證 ESM 自包含。

**`oidc-client-ts` 設定**（S21 寫明嘅預設值唔啱我哋用，要覆蓋）：
- `userStore` 預設係 sessionStorage → 改用 `InMemoryWebStorage`，token 只放記憶體。
- `stateStore` 預設係 localStorage → 改用 sessionStorage，只存 transaction state，callback 之後清走。
- `revokeTokensOnSignout` 預設 false → 改 true。`revokeTokenTypes` 應該限 refresh token，要驗證。
- `automaticSilentRenew`：要決定開唔開。
- **唔自己寫**任何 PKCE、state、簽名或 JWT parser。

**設定同模式**
- **`AUTH_MODE` 唔設定時：** 行為同現在 v1 完全一樣（loopback、冇登入）。
- **`AUTH_MODE=cognito` 時：** 必須提供 `COGNITO_REGION`、`USER_POOL_ID`、`COGNITO_DOMAIN`、`NATIVE_CLIENT_ID`、`GOOGLE_CLIENT_ID`、`OWNER_SUBS`、`AGENT_CLIENTS`（client_id 對 scope）、`PUBLIC_ORIGIN`。缺任何一個就拒絕啟動。
- Internet 環境冇 `none` 模式。

**新 API 契約（只喺 cognito 模式生效）**
- Token 用 `X-App-Authorization: Bearer <access token>` 傳；如果收到 `Authorization`，唔當佢係 app token。
- `GET /api/auth/config`：唔使登入，只回傳公開值（domain、兩個 client id、redirect、scope）。
- `GET /api/health`：唔使登入，唔回傳任何資料。
- `GET /api/me` → `{ role: owner|agent, sub|clientId, scopes }`。
- `GET /api/files/download` → 改回傳 JSON `{ url }`，前端用 fetch 攞到再導航過去。
- JPEG preview：前端用 fetch 帶 header，轉成 blob URL（CSP 加 `img-src blob:`）。PNG、GIF、WebP、PDF 嘅 metadata 照用 fetch。
- 上載：沿用現有串流 route，只係 XHR 加 header。**唔需要直傳 S3**。
- 以上改動令 cognito 模式唔會出現「登入咗但 download 或 preview 壞咗」。
- 權限分開：read 同 write 分開，刪除另外需要 delete scope。

**測試（離線，唔係真 login）**
- 測試入面用 `node:crypto` 生成 key，起一個 127.0.0.1 嘅 fake JWKS server，同一個 fake OIDC server（discovery、authorize、token、revoke）。
- `aws-jwt-verify` 點樣接入 fake JWKS，係實作時要證明嘅嘢。

**Phase A 驗收**
- 以下情況全部要拒絕：冇 token、過期、篡改簽名、iss/client/token_use 唔對、合法但 sub 唔喺 allowlist（包括 email 相同嘅偽造 claim）、agent 越權用 scope、token 放錯喺 `Authorization`。
- `oidc-client-ts` callback：state 唔對、callback 被 replay、callback 偽造、code 已經用過，都要拒絕。
- Token 唔會寫入 localStorage；登入交易相關 sessionStorage entries 喺 callback 之後清除；唔清除其他 app 嘅資料。
- 375/1280 px 下兩個選擇都顯示；email 路徑冇任何 Google 請求（瀏覽器測試攔截網絡）。
- 取消或出錯返回 chooser；logout 清走 token 並觸發 revoke 同 `/logout`。
- Download 同 JPEG preview 喺 cognito 模式正常。
- 未設定 `AUTH_MODE` 時，現有全部測試照樣通過。
- **做完即停，等 fresh independent read-only review**，之後 Eve 跑 gates。冇批准唔 commit、唔 push。

**Phase A 實作結果（離線，2026-10-11）**
- 版本：`aws-jwt-verify@5.2.1`（0 dependency）、`oidc-client-ts@3.5.0`（+ `jwt-decode@4.0.0`），exact pin，`npm install --ignore-scripts`；lockfile 只係新增 3 個 entry。
- Bundle：用 package 自己嘅 `dist/browser/oidc-client-ts.min.js`（自包含 IIFE，`jwt-decode` 已包埋，冇 `require`/`import`/`eval`），由 app 喺 `/vendor/` 原檔 serve，SHA-256 `f999daa3…74f1ef` 由測試釘死。`dist/umd`、`dist/esm` 都要外部 `jwt-decode`，所以冇用。
- Fake JWKS：用 library 自己嘅 `SimpleJwksCache` 加一個離線 fetcher（只答 pool 嘅 JWKS URL），經 `createAuth` 嘅測試專用參數注入；env 冇辦法指向 fake。
- 設定比原稿多咗 `AGENT_SCOPE_PREFIX`（resource server identifier），agent scope 係 `<prefix>/read|write|delete`。Phase A 只准 loopback（`HOST` 同 `PUBLIC_ORIGIN`）。
- `automaticSilentRenew` 決定**關**：token 過期或 401 就返 chooser；reload 都返 chooser，唔會自動 redirect。
- Logout：先清記憶體，再 revoke refresh token（只 revoke 呢個），再去 `/logout?client_id&logout_uri`（URL 冇 `id_token_hint`）。revoke 失敗照樣登出。
- `stateStore` 用 sessionStorage，key 前綴 `fm.oidc.<method>.`；`userStore` 用 `InMemoryWebStorage`。nonce 由 app 用 `crypto.randomUUID()` 產生交畀 library，儲存同核對由 library 做（錯 nonce 或者冇 ID token 都會拒絕，有測試同 mutation 證明）。
- Self-audit（2026-10-13）修正：session 完咗先返嚟嘅 download 唔再留低 `blob:` copy；token 只會送去本 origin 嘅 `/api/`（protocol-relative `//host` URL 唔再帶 token）。測試隔離：real-server child 同 in-process presign 都唔會再讀繼承環境指向嘅 AWS config 檔。
- Close-out round（2026-10-13，Mr. So 批准「Ok, approve 1-2」）：sign-in library 載入失敗時，login 區顯示固定錯誤（`role=alert`），兩個登入掣停用，唔顯示 file UI（375/1280 px 瀏覽器測試，先 RED 後 GREEN）；pool 自己 JWKS 入面有壞 key（`JwkValidationError`）改為 503，unknown `kid`、非簽名 key、錯 `alg` 仍然 401（離線測試先 RED 後 GREEN，加 mutation 證明）。之後實作者 self-audit（唔係獨立 review）再搵到 vendor script 載入成功但唔係 library（例如 proxy 頁面）都會變白頁，已經先 RED 後 GREEN 修正；亦用 pin test 確認 unknown `kid` 喺 library 10 秒等待期內、同冇 `kid` 嘅 token 都仍然 401。詳見 `docs/HANDOFF.md`。

## 4. Phase B（之後另外批，Phase A 唔做）

- **CloudFront OAC 轉發去 Function URL：** 要兩條 permission；POST/PUT 要帶 `x-amz-content-sha256`（S4）；PUBLIC_ORIGIN 同 Host 嘅 guard 要 runtime 驗。
- **100 MiB 檔案過唔到 Lambda**（S5/S14），要改用 MPU 直傳 S3。
  - **前提：** 用 library 實作嘅簽名 ticket，綁定 owner sub 或 agent client_id、bucket、key、uploadId、大小上限同到期時間；或者另外批准一個 server-side state 服務。
  - 用乜 package、secret 點管理，要另外決定，**唔預設**用 Secrets Manager。
  - 淨係靠 key + uploadId 加 write scope 唔夠安全。
- **Complete 流程：** server 做 ListParts，用返得到嘅 ETag 做 conditional complete。要測試 part race、MPU 過期、abort 同 lifecycle。
- **大小唔對時唔准大範圍自動刪除：** 自動刪可能刪錯替換咗嘅 object。要有 version 或 ETag 保障，安全嘅清理流程另外批。
- **CopyObject 文件矛盾：** S8 寫 CopyObject 支援 `If-None-Match`，但 S18 寫 bucket 強制 policy 下 CopyObject 會回 403/501。所以**唔加全 bucket 強制 policy**；SDK 支唔支援要按版本實測。
- **6 MB 上限：** 1 MiB text preview 經 JSON escape 可能超過 6 MB；保留既有 1 MiB 規則，改 transport（例如經驗證嘅 streaming 或 raw-text 合約），唔可以未經批准降低預覽上限。JPEG 要有輸出 byte 上限同 envelope 測試；pixel 上限唔代表 byte 上限。
- **其他：** sharp 要用 linux arm64 或 x64 binary（S13）；LWA 用 buffered 或 streaming（S12）；CloudFront origin timeout 上限 120 s 而 Lambda 係 900 s（S14），要明確設定。
- **Presigned URL：** 係 bearer，logout 之後仍然有效；已經開始嘅下載會繼續（S9）。

## 5. Phase C 同 runtime gates（之後另外批）

- 開 user pool、兩個 client、Google OAuth client；做 link runbook；決定 MFA 同 recovery 設定；設定 CloudFront callback。
- 要實測：公司網絡（CloudFront、Cognito、S3、recovery 郵件）、手機 mobile data、iPhone `prompt=none`、真實 S3。
- 唔可以繞過公司網絡政策。

## 6. 未證實項目

Phase A 離線解決咗：
- Fake JWKS 點樣接入（見第 3 節「Phase A 實作結果」）。
- Bundle 形式（`dist/browser` 自包含 build）。
- App 自己嘅頁面喺 email 路徑冇 Google request（瀏覽器測試攔截網絡；只證明 app 同 fake login，唔包括真 Cognito hosted UI）。

仍然 pending：
- 真 Cognito hosted UI 喺 email 路徑有冇載入 Google 資源。
- `oidc-client-ts` 同真 Cognito 配合：直接畀 endpoint metadata（冇 discovery）、revoke token type、`/logout`、nonce、`identity_provider`。
- 真 pool 用 `http://localhost` callback。
- Phase B 嘅 ticket、part race 同 6 MB envelope。
- 取得 Google sub 嘅可信方法。
- Attribute mapping 同 recovery。

## 7. 批准請求（歷史記錄：Mr. So 已批准 Phase A，見文首狀態；Phase B、Phase C 未批）

> **批准 Phase A：本地 auth 同兩個選擇嘅登入、`aws-jwt-verify` 同 `oidc-client-ts`，以及最簡單嘅同一 origin browser artifact 流程。唔做 AWS/Google 設定、部署、commit 或 push。**

## 來源（全部係文件研究，未 runtime 驗證）

- S1 https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html ：「For Amazon Cognito user pools, use the value `COGNITO`」；PKCE 只支援 S256；有 `prompt=none`
- S2 https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html ：Destination 用「the username in the user pool」；Google 用 `Cognito_Subject`；「hasn't yet signed in」
- S3 https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html ：federated 用戶冇額外 factor；email MFA 同 email recovery 衝突；第一次登入照發 token
- S4 https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html ：要 `InvokeFunctionUrl` 同 `InvokeFunction`；要 `x-amz-content-sha256`
- S5 https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html ：6 MB / 200 MB streamed；900 s
- S6 https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp-google.html ：redirect 用 `/oauth2/idpresponse`；基本 scope 唔使列 test user；唔會按 email 自動 merge
- S7 https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html ：冇 link 會自動開 profile；已登入過要先刪除；會更新 linked profile
- S8 https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html ：`If-None-Match` 支援 Put、CompleteMPU、Copy；412/409
- S9 https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html ：bearer；已開始嘅下載會繼續
- S10 https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html ：M2M 要 secret、custom scopes；收費文字同 S15 唔一致
- S11 https://github.com/awslabs/aws-jwt-verify ：查 iss、token_use、clientId array、scope；0 dependency
- S12 https://github.com/awslabs/aws-lambda-web-adapter ：支援 Function URL、response_stream、readiness
- S13 https://sharp.pixelplumbing.com/install ：Lambda 要 linux-x64 或 arm64 binary
- S14 https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html ：origin response timeout 1–120 s
- S15 https://aws.amazon.com/cognito/pricing/ ：「charges you monthly per successful token response」；「no additional charge for the number of app clients」
- S16 https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html ：「revoked tokens will still be valid if they are verified using any JWT library」
- S17 https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html ：「doesn't sign users out of OIDC or social identity providers」
- S18 https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html ：強制 policy 下 CopyObject 回 403/501
- S19 https://github.com/authts/oidc-client-ts ：「Authorization Code Grant with… PKCE」、「Refresh Token Grant」、session 同 token 管理；Apache-2.0
- S20 https://raw.githubusercontent.com/authts/oidc-client-ts/main/package.json ：exports 指向 `dist/esm`、`dist/umd`；dependency 係 `jwt-decode`（版本批准後先揀）
- S21 https://authts.github.io/oidc-client-ts/interfaces/UserManagerSettings.html ：userStore 預設 sessionStorage；stateStore 預設 localStorage；`revokeTokensOnSignout` 預設 false