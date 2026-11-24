# قائمة المراجعة والتطوير — gowa-lite

> المرجع الهندسي المعتمد: `affaan-m/ECC` (`skills/coding-standards/SKILL.md` — commit `4adeee6732a12d1540f49a4d50a38ce8c97f9a53`)
> المرجع الوظيفي: `compnew2006/gowa-ui` | مرجع التصميم: `pbakaus/impeccable` (`v4.10.0`)
> تاريخ الإنشاء: `2026-11-23` | تاريخ التحديث: `2026-11-24`
> الحالة الحالية: **67/68 بندًا مكتملًا** — تم إنجاز المرحلة العاشرة لقائمة إجراءات المحادثة الجانبية (`5/5` بنود) ويتبقى فقط التحقق الحي أمام خادم GOWA (`PROD-03`).

---

## العمل المتبقي

### التحقق الإنتاجي الحي

- [ ] **PROD-03 (`P2`)**: التحقق التكاملي الحي أمام خادم GOWA حقيقي (دعم `PATCH /send/schedules/:id`، وأحداث `MESSAGE_REVOKED`، وتحديث العداد اللحظي). *يتطلب `GOWA_URL` متصلًا — متاح عبر `npm run verify:live`.*

---

## سجل الأعمال المكتملة

<details>
<summary>عرض تفاصيل المراحل المكتملة (`67/67`)</summary>

### المرحلة الأساسية 1: الاحتواء الأمني، تثبيت الجلسة، إصلاح محرك المزامنة/غير المقروء/المجدولة، وتحديث شريط المحادثات (`12/12`)

#### 1. الأمان والحدود الحرجة للتشغيل

- [x] **F-01 (`P0`)**: منع تسريب كلمة مرور خادم `gowa` المحفوظة عبر `POST /api/settings/gowa/test` عند تمرير `gowa_url` جديد مختلف في `origin` عن العنوان المحفوظ (`server/security.ts`, `server.ts`).
- [x] **F-02 (`P1`)**: الحفاظ على جلسة المستخدم عند إعادة تحميل الصفحة (`F5`) باستخدام كوكي `HttpOnly` آمن (`SameSite=None; Secure; Partitioned` في HTTPS، و`SameSite=Lax` في HTTP المحلي) مع حماية CSRF (`Origin` / `X-Requested-With`) ودعم `Authorization: Bearer` المتزامن دون تخزين أي tokens في `localStorage` أو `sessionStorage` (`server/security.ts`, `server.ts`, `src/lib/http.ts`).
- [x] **F-03 (`P1`)**: إضافة Rate Limiter (`AuthRateLimiter`) على `/api/auth/login` و`/api/auth/setup` لمنع التخمين (إرجاع `429` مع `Retry-After`)، وتحويل `scryptSync` إلى `crypto.scrypt` غير المتزامن حتى لا يتجمد Event Loop (`server/security.ts`, `server/db.ts`, `server.ts`).
- [x] **F-09 (`P2`)**: حماية `decodeURIComponent` لمعلمات المسارات (`deviceId`, `jid`, `id`, `messageId`) عبر `decodeRouteParam` + معالج أخطاء Express JSON لمسارات `/api/*` بحيث تُرجع JSON `400 VALIDATION_ERROR` بدل إسقاط الطلب بصفحة HTML 500/400 `URIError` (`server/security.ts`, `server.ts`).

#### 2. محرك عدم القراءة المعزول، الرسائل المحذوفة، وإعادة الجدولة

- [x] **F-04 (`P1`)**: إصلاح `syncChatWatermarks` ومسار `catchup`: عدم مسح علامة التحديث قبل نجاح جلب الرسائل (عمود `needs_catchup` + `catchup_prev_ms` في `chat_sync_state`)، ومعالجة أكثر من 10 محادثات متأخرة عبر الدورات المتتالية دون ضياع `unread_count`، وتوحيد `chat_id` بدون لاحقة `@s.whatsapp.net` في أحداث WebSocket (`server/db.ts`, `server.ts`).
- [x] **F-05 (`P1`)**: إصلاح أداء `getUnreadCountsForUser`: استبدال تحميل جميع صفوف `cached_messages` في ذاكرة Node باستعلام SQL تجميعي (`LEFT JOIN user_chat_read_states` + `COUNT(*)`) مع فهرس جزئي مناسب (`idx_cached_messages_unread_active`) (`server/db.ts`).
- [x] **F-06 (`P1`)**: إصلاح انزياح التصفح (`Pagination Offset Drift`) عند حقن الرسائل المحذوفة: تمرير `live_total` و`raw_count` و`next_offset` الفعلي من GOWA في `pagination` وتحديث `getNextPageParam` في `MessageView` حتى لا تُتخطى رسائل حية عند التمرير للأعلى (`server/db.ts`, `server.ts`, `src/api/types.ts`, `src/features/chat/message-view.tsx`).
- [x] **F-07 (`P1`)**: إصلاح سباق `markAsRead`: إضافة `pendingMarkReadRef` لتنفيذ إعادة التحديد كمقروء تلقائيًا إذا وصلت رسالة جديدة أثناء وجود طلب `/read` قيد التنفيذ (`src/features/chat/message-view.tsx`).
- [x] **F-08 (`P1`)**: تأمين المسار الاحتياطي لإعادة الجدولة (`PATCH /api/unified/chats/:deviceId/:jid/schedules/:id`): البحث عبر صفحات `/send/schedules` حتى 500 عنصر، الحفاظ على حالة `paused` للجدولة المعاد إنشاؤها، وتنفيذ تراجع تعويضي وإرجاع خطأ `502 RESCHEDULE_CANCEL_FAILED` عند فشل إلغاء الجدولة القديمة (`server.ts`).

#### 3. واجهة شريط المحادثات الجانبي (متطلبات المستخدم المباشرة)

- [x] **UX-01 (`P1`)**: إضافة ويدجت/مؤشر واضح في شريط المحادثات الجانبي (`ChatList` وفي شريط التنقل `AppShell`) يعرض عدد الرسائل غير المقروءة **للمستخدم المسجَّل دخوله حاليًا** بشكل معزول (يظهر دائمًا مع اسم المستخدم ويعرض `0` أو العدد الفعلي مع إمكانية النقر لتصفية غير المقروءة في العرض الموحد وSplit View، وشارة عدد على أيقونة المحادثات في `AppShell`) (`src/features/chat/chat-list.tsx`, `src/pages/chats.tsx`, `src/components/layout/app-shell.tsx`, `src/lib/i18n.ts`).
- [x] **UX-02 (`P1`)**: تطويل/توسيع الويدجت الذي يعرض اسم الحساب القادم منه الرسالة في بطاقة المحادثة (`chat-list.tsx`) وقائمة اختيار الحساب (`AccountMultiSelect`) عبر إزالة القيد الضيق `max-w-[104px]` واستبداله بـ `min-w-0 max-w-[72%]` و`max-w-[220px]` ليتمدد مع عرض الشريط الجانبي ولا يقطع أسماء الحسابات الطويلة (`src/features/chat/chat-list.tsx`).

#### 4. اختبارات التحقق للمرحلة الأساسية 1

- [x] **TEST-01 (`P1`)**: إضافة سكريبت `test` في `package.json` وكتابة اختبارات آلية معزولة (`tests/phase1.test.ts` عبر `tsx --test` مع قاعدة بيانات مؤقتة `GOWA_LITE_DB_PATH`) تغطي: عزل عداد غير المقروء لكل مستخدم، استكمال `needs_catchup` لأكثر من 10 محادثات، دمج الرسائل المحذوفة وفصل `rawCount`/`injectedCount`، تشفير/تحقق كلمة المرور غير المتزامن، وفحوصات الأمان (`decodeRouteParam`، `AuthRateLimiter`، CSRF، وحماية `gowa/test`).

### المرحلة الأساسية 2: التبسيط المعماري، توحيد الجدولة، جودة النوعية، ومراجعة الصفحات المتبقية (`7/7`)

- [x] **ARCH-01 (`P2`)**: تقسيم `server.ts` (3037 سطر) إلى وحدات منظمة (`server/middleware/*`, `server/routes/*`, `server/services/*`) وجعل استيراد `vite` ديناميكيًا داخل فرع التطوير فقط.
- [x] **ARCH-02 (`P2`)**: تفكيك `MessageView` (1134 سطر) و`ChatContextDrawer` (1044 سطر) إلى مكونات أصغر واضحة المسؤولية (`< 50` سطرًا للدالة قدر الإمكان).
- [x] **DRY-01 (`P2`)**: توحيد منطق ونموذج إنشاء/تعديل الجدولة (`F-10`) بين `schedule-dialog.tsx` و`scheduled.tsx` و`chat-context-drawer.tsx`، وتوحيد حد الوقت المستقبلي على الخادم في كلا مساري الجدولة (`/unified/chats/.../schedules` و`/devices/:deviceId/schedules`).
- [x] **TS-01 (`P2`)**: تفعيل `"strict": true` في `tsconfig.json` وتقليل التحويلات القسرية (`as unknown as`) في `server/db.ts`.
- [x] **DEPS-01 (`P2`)**: تنظيف `package.json` من الحزم غير المستخدمة (`@google/genai`, `motion`) والتحقق من سلوك `viteSingleFile` في الإنتاج.
- [x] **WS-01 (`P2`)**: مراجعة تمرير اعتماد GOWA في WebSocket (`?authorization=` في `server/ws-bridge.ts:182`) ونقله للترويسة إذا دعمه خادم GOWA المستهدف.
- [x] **AUDIT-01 (`P2`)**: فحص صفحات الإدارة غير المفحوصة بعد (`accounts.tsx`, `account.tsx`, `groups.tsx`, `users.tsx`, `misc.tsx`) والتأكد من عدم وجود ثغرات أو تكرار بها.

### المرحلة الأساسية 3: بوابة الجودة والتشغيل الإنتاجي (`2/3`)

- [x] **PROD-01 (`P1`)**: اختبار بناء الإنتاج الكامل (`npm run build` ثم `NODE_ENV=production node server.ts`) والتحقق من تقديم الواجهة وجميع مسارات `/api/*` و`/ws` (`tests/phase3.test.ts`).
- [x] **PROD-02 (`P2`)**: إضافة `README.md` يوثق متغيرات البيئة (`ADMIN_PASSCODE`, `GOWA_LITE_DB_PATH`, `PORT`)، خطوات التشغيل، والنسخ الاحتياطي لقاعدة `gowa-lite.db`.

### التطوير الإضافي — المرحلة الأولى: الإرسال المتكامل والربط العميق للمحادثات (`3/3`)

- [x] **CHAT-MEDIA-01 (`P0`)**: دعم إرسال الصور والفيديو والصوت والمستندات في المحادثات (`POST /api/unified/chats/:deviceId/:jid/send-media` عبر `application/octet-stream` بحد 20MB وحظر الملفات التنفيذية + `MessageComposer` بزر مرفقات ومعاينة قبل الإرسال + لصق `Ctrl+V` + سحب وإفلات `Drag & Drop` مع `caption` وتحديث فوري للكاش المحلي).
- [x] **NAV-DEEP-01 (`P1`)**: دعم بدء محادثة جديدة برقم هاتف (`NewChatDialog` في `ChatList`) والربط العميق عبر معاملات الرابط `/chats?device=...&jid=...` (مع دعم فتح محادثة فورية حتى لو لم تظهر في أحدث 100 محادثة)، وتحديث رابط «فتح في المحادثات» في `/account` و`/accounts` لتمرير الحساب/المستلم تلقائيًا.
- [x] **TEST-NEW-01 (`P1`)**: اختبارات آلية لمسار إرسال الوسائط (تصنيف نوع الملف إلى مسار `GOWA` المناسب، حظر الامتدادات التنفيذية، وتنظيف الأسماء) ومنطق بناء JID والربط العميق (`tests/phase4.test.ts`).

### التطوير الإضافي — المرحلة الثانية: استقرار الكاش، المزامنة، والموثوقية (`3/3`)

- [x] **DB-MAINT-01 (`P1`)**: تنظيف دوري خفيف لجداول SQLite (`sessions` المنتهية الصلاحية و`contact_avatars` القديمة) مع إغلاق اتصال قاعدة البيانات بأمان (`db.close()`) عند إشارة `SIGTERM` لتفريغ ملف `WAL`.
- [x] **SYNC-FIX-01 (`P1`)**: الحفاظ على بيانات المرفق والرد الأصلية عند استقبال حدث `MESSAGE_EDITED` في `server/services/chat-sync.ts`، وتضييق `invalidateQueries` في صفحة المحادثات حسب `device_id` و`chat_jid` عند توفرهما بدل الإبطال الشامل.
- [x] **UI-PORTAL-01 (`P2`)**: نقل مكون `Dialog` إلى `createPortal(..., document.body)` مع استعادة التركيز عند الإغلاق ومنع تسرب النقرات وتعارض `z-index` هيكليًا.

### التطوير الإضافي — المرحلة الثالثة: التوسع والإنتاجية اليومية (`3/3`)

- [x] **CHATS-PAGINATION-01 (`P0`)**: دعم تصفح المحادثات الأقدم (`offset` وزر «تحميل المزيد») في `GET /api/unified/chats` و`ChatList` لتجاوز حد أول 100 محادثة مع دمج ومنع تكرار آمن عبر `usePaginatedChats`.
- [x] **MSG-ACTIONS-01 (`P1`)**: إضافة إجراءات حذف الرسالة للجميع (`Revoke`) وإعادة التوجيه لمحادثة أو حساب آخر (`Forward`) في `MessageBubbleActions` مع `ForwardMessageDialog` ومحاورة التأكيد ومسارات الخادم الخلفية.
- [x] **UX-NOTIFY-01 (`P2`)**: تحديث عنوان التبويب (`document.title`) بعدد الرسائل غير المقروءة مع خيار إشعار صوتي (Web Audio API) وإشعار متصفح (`Notification`) للرسائل الواردة عبر `NotificationControls`.

### إصلاحات الاعتمادية والمزايا المضافة (`3/3`)

- [x] **AUTH-FIX-01 (`P0`)**: منع انهيار تفكيك `{token, user}` من `null` في صفحتَي الدخول والإعداد الأولي عند وصول رد `2xx` غير JSON أو غير مكتمل، عبر التحقق الصارم في `unwrapApiResults` (`src/lib/http.ts`) وحراسة الجلسة في `LoginPage` و`SetupPage` مع اختبار وحدة في `tests/phase4.test.ts`.
- [x] **CHAT-OVERLAP-01 (`P1`)**: إضافة شارة «متاح أيضًا على حساب آخر» مع أسماء الحسابات في قائمة المحادثات وترويسة المحادثة مع إمكانية التبديل المباشر إلى محادثة العميل على الحساب الآخر، مع استبعاد الحالات والقنوات وتوحيد صيغة `@c.us` و`@s.whatsapp.net`.
- [x] **MISC-STATUS-01 (`P1`)**: تجميع وعرض حالات واتساب (`status@broadcast`) لجميع الحسابات في `/#/misc` (مع تصفية حسب الحساب وبحث ومعاينة وسائط ورابط فتح محادثة المرسل وتحديث فوري عبر WebSocket)، واستبعاد `status@broadcast` من صندوق المحادثات والتنبيهات الواردة.

### المرحلة الرابعة: نظام الأدوار المخصصة وتقييد الحسابات (`/settings/roles` و`/settings/users`) (`3/3`)

- [x] **RBAC-01 (`P0`)**: إنشاء جداول `roles`, `role_permissions`, `user_device_access` في `SQLite` مع ترحيل تلقائي آمن للمستخدمين الحاليين (`admin` / `agent`)، وتوليد 29 صلاحية قياسية عبر 9 موارد، وقراءة الصلاحيات الفعالة والحسابات المسموحة لحظيًا داخل الجلسة (`getSessionUser`).
- [x] **RBAC-02 (`P0`)**: تطبيق `requirePermission` و`assertDeviceAccess` على جميع مسارات الـ API وبث WebSocket (`ws-bridge.ts`) بنمط Fail-Closed، وإضافة مسارات `/api/roles`, `/api/permissions` وتحديث `/api/users` مع حماية منع تصعيد الصلاحيات وآخر مسؤول نشط وإبطال الجلسات واتصال WebSocket (`4001`) فور التعطيل (`tests/phase4-rbac.test.ts`).
- [x] **RBAC-03 (`P1`)**: بناء واجهتَي `/settings/roles` (`PermissionMatrix` ثلاثية الحالة مع حارس تغييرات غير محفوظة) و`/settings/users` (تعيين الدور وتخصيص حسابات واتساب المسموحة وإعادة توجيه `/users`) وتطبيق حراسة المكونات والواجهات في `App.tsx` و`AppShell` والصفحات الفرعية.

### المرحلة الخامسة: محرك دورة حياة المحادثة وتعيين جهات الاتصال (`Assign Contact` & `Lifecycle`) (`3/3`)

- [x] **LIFECYCLE-01 (`P0`)**: إنشاء جدولي `chat_assignments` و`chat_lifecycle_events` في `SQLite` وخدمة `server/services/chat-lifecycle.ts` مع معاملات `BEGIN IMMEDIATE` للاستلام الذري (`409 Conflict` عند التسابق)، إعادة تعيين المحادثات المفتوحة للانتظار عند حذف الوكيل (`deleteUser`)، وإعادة الفتح التلقائي للمحادثات المغلقة عند ورود رسالة من العميل.
- [x] **LIFECYCLE-02 (`P0`)**: إضافة مسارات الخادم `claim`, `assign`, `release`, `close`, `reopen`, `bulk-lifecycle`, `assignable-agents` (مع عداد المحادثات المفتوحة لكل وكيل)، وسياسة الصندوق (`/api/settings/inbox-policy`) المفروضة على الإرسال (`/send`, `/send-media`) مع بث أحداث `CHAT_LIFECYCLE_UPDATED` و`INBOX_POLICY_UPDATED` عبر WebSocket (`tests/phase5-lifecycle.test.ts`).
- [x] **LIFECYCLE-03 (`P1`)**: بناء مكون `AssignChatDialog` الموحد، أزرار ومؤشر دورة الحياة في `MessageViewHeader`، قفل المرسل في `MessageComposer` مع أزرار التعافي، بطاقة إعدادات سياسة الصندوق في `/settings`، وعرض أحداث النظام الزمنية مدمجة بالترتيب الزمني داخل `MessageView`.

### المرحلة السادسة: تبويبات `All - Me - Pending - Closed` والعدادات الخادمية في `/chats` (`3/3`)

- [x] **CHAT-TABS-01 (`P0`)**: تحديث `GET /api/unified/chats` لدعم `tab=all|me|pending|closed` وإرجاع `tab_counts` الدقيقة من الخادم مع ترقيم SQLite مباشر لتبويب `closed` من `chat_assignments` وإثراء العناوين والتوقيت من الكاش (`server/routes/unified-inbox.ts`, `server/services/chat-lifecycle.ts`, `server/db.ts`).
- [x] **CHAT-TABS-02 (`P1`)**: إضافة شريط التبويبات الأربعة (`role="tablist"` + تنقل الأسهم RTL/LTR + `tabular-nums`) في `ChatList` مع تمييز سلوك `Me` للمشرفين عن الوكيل، وإظهار المالك/الحالة بنمط `Zero-Pill`، ودعم التحديد الجماعي للإغلاق/التحرير/إعادة الفتح (`src/features/chat/chat-list.tsx`, `src/pages/chats.tsx`, `src/features/chat/use-paginated-chats.ts`, `src/lib/i18n.ts`).
- [x] **CHAT-TABS-03 (`P2`)**: تضييق تنبيهات الصوت والمتصفح في `notifications.ts` (`shouldAlertIncomingChat`) و`AppShell` لتصل للوكيل فقط على الحسابات المسموحة والمحادثات المتاحة له (`pending` أو مسندة إليه أو المعاد فتحها تلقائيًا) (`src/lib/notifications.ts`, `src/components/layout/app-shell.tsx`).

### المرحلة السابعة: صقل الواجهة (`Impeccable`) والاختبارات الشاملة (`2/2`)

- [x] **DESIGN-IMPECCABLE-01 (`P1`)**: مراجعة وصقل شاشات `/settings/roles` و`/settings/users` و`/chats` وفق قواعد `pbakaus/impeccable`: `Zero-Pill`، حالات `focus-visible` على جميع الضوابط والأزرار، دعم RTL/LTR، وتحسين سرعة التحميل والعرض (`src/index.css`, `src/lib/media-download.ts`, `vite.config.ts`, `src/pages/roles.tsx`, `src/pages/users.tsx`, `src/features/rbac/permission-matrix.tsx`, `src/features/chat/message-bubble.tsx`, `src/features/chat/message-view-header.tsx`).
- [x] **TEST-PHASE5-01 (`P0`)**: كتابة اختبارات شاملة في `tests/phase5.test.ts` (الأدوار المخصصة ومنع تصعيد الصلاحيات، تقييد الحسابات، التسابق `409 Conflict` في `Claim`، الترقيم والبحث في `Closed` بدون طلب GOWA، إعادة فتح العميل التلقائية، وتصفية التنبيهات) والتحقق من `npm test` و`tsc --noEmit` و`npm run build`.

### المرحلة الثامنة: التحصين الأمني، الأداء الإنتاجي، جودة الكود، ونظافة الاعتماديات (`9/9`)

- [x] **SEC-01 (`P0`)**: إزالة `gowa-lite.db*` و`bun.lock` من تتبع Git عبر `git rm --cached` وإضافة قواعد الحجب في `.gitignore`، وتشفير `gowa_password` في `SQLite` عبر `AES-256-GCM` (`enc:v1:...`) مع ترحيل تلقائي للقيم النصية القديمة وإدارة المفتاح عبر `GOWA_SETTINGS_SECRET` أو ملف `${dbPath}.key` بصلاحية `0o600` (`server/db.ts`, `.gitignore`, `.env.example`).
- [x] **SEC-02 (`P0`)**: ضبط `trust proxy` عبر `TRUST_PROXY` (`parseTrustProxySetting`) وقراءة IP الحقيقي في `getClientIp(req)` بدل الترويسة العمياء `X-Forwarded-For`، وتقييد ذاكرة `AuthRateLimiter` بحد `maxBuckets` مع التنظيف الدوري وإخلاء الأقدم لمنع استهلاك الذاكرة (`server/security.ts`, `server.ts`).
- [x] **SEC-03 (`P0`)**: فرض تمرير والتحقق من `deviceId` (`assertDeviceAccess`) على `/api/unified/media/file` وتحديث مستدعياته في الواجهة، وتطبيق `buildSafeMediaHeaders` (`Content-Disposition: attachment` + `Content-Security-Policy: default-src 'none'; sandbox` لأنواع MIME غير المدرجة في القائمة البيضاء مثل SVG/HTML) على مساري الوسائط و`/api/devices/:id/qr-image` (`server/security.ts`, `server/routes/unified-inbox.ts`, `server/routes/devices.ts`, `src/features/chat/*`, `src/features/groups/newsletter-messages-panel.tsx`).
- [x] **SEC-04 (`P0`)**: تحصين `validateGowaUrl` لحجب عناوين Cloud Metadata وLink-Local دائمًا وحظر عناوين الشبكة الداخلية عند تفعيل `BLOCK_PRIVATE_GOWA_URL=true`، وإصلاح ثغرة DNS Rebinding TOCTOU في `fetchPublicAvatarImage` بتثبيت الـ IP المفحوص داخل `http.request`/`https.request` مع حد أقصى `2MB` وتمرير SNI (`server/gowa-client.ts`).
- [x] **PERF-01 (`P1`)**: استبدال `zlib.gzipSync` المتزامن بوسيط `compression` غير المتزامن (مع `ENABLE_COMPRESSION` وحد `1024B`)، وجعل رسالة خطأ `413` تحسب الحد الأقصى ديناميكيًا (`20 ميجابايت` لمسار `/send-media` و`8 ميجابايت` لبقية مسارات JSON) (`server.ts`, `package.json`).
- [x] **PERF-02 (`P1`)**: تقليل استعلامات `GET /api/unified/chats` في تبويبي `me`/`closed` عبر `getAssignmentStatsForDevices`، وإصلاح حساب `tab_counts.pending` عند المسح الجزئي حتى لا يتأثر بعدد المحادثات المغلقة المؤرشفة، وإضافة ذاكرة مستخدمين مفهرسة بالنسخة (`getUserCacheVersion`) في `GowaWsBridge`، وزيادة `staleTime` لاستعلام `globalChatsQuery` في `chats.tsx` (`server/services/chat-lifecycle.ts`, `server/services/unified-chats-service.ts`, `server/ws-bridge.ts`, `src/pages/chats.tsx`).
- [x] **REL-02 (`P1`)**: إصلاح صمت إعادة الاتصال عند `upstream.on('error')` في `GowaWsBridge` باستدعاء `scheduleReconnect(deviceId)` قبل الإنهاء، وتسجيل تحذير عند إطارات JSON التالفة، وإضافة `PRAGMA busy_timeout = 5000;` في `server/db.ts`.
- [x] **ARCH-03 (`P1`)**: إزالة آخر استعلامَي `SELECT *` وتقليص التحويلات القسرية في `chat-lifecycle.ts` و`db.ts`، وتفكيك `GET /api/unified/chats` إلى دوال مركّزة في `server/services/unified-chats-service.ts`، وتغطية مدخلات المسارات الحساسة بـ `Zod` في `server/validation/schemas.ts` (`auth.ts`, `roles.ts`, `chat-lifecycle.ts`, `unified-inbox.ts`).
- [x] **OPS-01 (`P1`)**: ضبط `engines.node >= 22.18.0` وتنظيم `devDependencies` وحذف `vite-plugin-singlefile` وتوليد `package-lock.json`، وتحديث `README.md` بالمتطلبات والمتغيرات وأمن المفتاح، وإضافة `scripts/verify-live-gowa.ts` (`npm run verify:live`) واختبارات `tests/phase8-hardening.test.ts` (`package.json`, `README.md`, `tests/phase8-hardening.test.ts`, `scripts/verify-live-gowa.ts`).
- [x] **USER-ACCOUNTS-01 (`P1`)**: إصلاح وترقية تخصيص حسابات واتساب المسموح بمشاهدة رسائلها في `/#/settings/users` بمنهجية TDD: تتبّع صريح لوضع التقييد (`all` / `specific`) لمنع التراجع الصامت لكل الحسابات، كتالوج حسابات مرن (`GET /api/users/assignable-accounts`) يدمج أجهزة GOWA الحية مع المعرّفات المحفوظة محليًا عند انقطاع الاتصال، حوار تخصيص مباشر من صف المستخدم مع بحث وإضافة يدوية، وبث `USER_ACCESS_UPDATED` فوري لتحديث الجلسات المفتوحة (`server/db.ts`, `server/ws-bridge.ts`, `server/routes/devices.ts`, `server/routes/auth.ts`, `src/features/users/*`, `src/pages/users.tsx`, `src/components/layout/app-shell.tsx`, `tests/phase9-user-accounts.test.ts`).

### المرحلة التاسعة: عزل المجموعات، حماية المحتوى، صقل تجربة الدردشة، والتنزيل المباشر (`8/8`)

- [x] **CHAT-BLUR-01 (`P0`)**: حجب محتوى المحادثات والملاحظات والجدولة والوسائط وبث WebSocket على الخادم (`content_redacted`, `redaction_reason`) لأي محادثة في حالة انتظار (`pending`) أو مغلقة (`closed`) أو مسندة لوكيل آخر بحيث يظهر للوكيل الاسم والرقم والصورة فقط حتى الاستلام أو إعادة الفتح (`server/services/chat-lifecycle.ts`, `server/routes/unified-inbox.ts`, `server/ws-bridge.ts`, `src/features/chat/message-view.tsx`, `tests/chat-content-blur.test.ts`).
- [x] **CHAT-CLOSED-VIS-01 (`P1`)**: إتاحة تبويب المحادثات المغلقة (`Closed`) لجميع الوكلاء لإعادة فتح أي محادثة مغلقة، ومعالجة اختفاء المحادثة المختارة فور استلامها أو إعادة فتحها عبر `resolveSelectedUnifiedChat` والاحتفاظ بسياق المحادثة (`src/features/chat/selected-chat.ts`, `src/pages/chats.tsx`, `server/services/unified-chats-service.ts`).
- [x] **CHAT-SCROLL-01 (`P1`)**: التمرير التلقائي الفوري لأسفل محادثة الدردشة لعرض أحدث رسالة مباشرة بعد فتح المحادثة أو استلامها دون الحاجة للتمرير اليدوي (`src/features/chat/scroll-behavior.ts`, `src/features/chat/message-view.tsx`).
- [x] **CHAT-CLEAN-01 (`P1`)**: تنظيف شاشة `/#/chats` من العناصر والمؤشرات المكررة وإزالة سقف `+99`: إخفاء تكرار الرقم عند تطابقه مع الاسم، إخفاء فلتر/اسم الحساب عند وجود حساب واحد، حذف ويدجت غير المقروء الإضافي المكرر، وإخفاء الحالة المكررة داخل تبويبها (`src/features/chat/chat-ui-helpers.ts`, `src/features/chat/chat-list.tsx`, `src/components/layout/app-shell.tsx`, `tests/chat-ui-cleanliness.test.ts`).
- [x] **CHAT-REACT-01 (`P1`)**: إعادة بناء منتقي التفاعلات (`Emoji Picker`) عبر `React Portal` ليطفو فوق/تحت فقاعات الرسائل خارج صفوف الاختيار المتعدد مع حساب دقيق للموضع يمنع قصّ نصف الرموز في الرسائل القصيرة وبأسلوب الوضع النهاري لواتساب (`src/features/chat/reaction-picker-position.ts`, `src/features/chat/message-bubble.tsx`, `tests/reaction-picker-portal.test.ts`).
- [x] **GROUPS-ISOLATION-01 (`P0`)**: عزل المجموعات (`@g.us`) عن `/#/chats` ودورة الحياة وإشعاراتها وعرضها حصريًا في `/#/groups` مع عداد غير المقروء الفعلي على أيقونتي `/#/chats` و`/#/groups` بدون سقف `+99`، وتفعيل التحديث اللحظي لحذف الرسائل (`MESSAGE_REVOKED`) عبر WebSocket (`server/services/chat-sync.ts`, `server/routes/groups.ts`, `src/components/layout/app-shell.tsx`, `tests/groups-isolation-and-realtime-revoke.test.ts`).
- [x] **GROUPS-MESSAGES-01 (`P0`)**: إصلاح خطأ `messages.map is not a function` في منشورات القنوات (`NewsletterMessagesPanel`)، وإضافة تبويب «الرسائل» المباشر داخل `/#/groups` لعرض وإرسال رسائل المجموعات ووسائطها وتفاعلاتها (`src/features/groups/newsletter-messages-panel.tsx`, `src/features/groups/group-workspace-panel.tsx`, `src/features/chat/message-view.tsx`).
- [x] **MEDIA-DOWNLOAD-01 (`P1`)**: تحويل فقاعة الملفات إلى تنزيل مباشر على الجهاز بضغطة واحدة بدل مرحلتين، وتسمية الملفات والوسائط المنزلة بصيغة رقم جهة اتصال المحادثة متبوعًا بالتاريخ والساعة ثم الامتداد (`src/lib/media-download.ts`, `src/features/chat/message-media.tsx`, `src/features/chat/use-media-batch.ts`, `tests/media-download.test.ts`).

### المرحلة العاشرة: قائمة إجراءات المحادثة الجانبية (`Chat Row Context Menu`) (`5/5`)

- [x] **CHAT-MENU-01 (`P1`)**: إضافة زر القائمة المنسدلة (`⌄`) عند التمرير/التركيز مع دعم النقر بزر الفأرة الأيمن (`Context Menu`) على صفوف المحادثات في `ChatList` عبر `React Portal` منضبط التموضع في RTL/LTR والوضعين النهاري والليلي (`src/features/chat/chat-row-menu.tsx`, `src/features/chat/chat-menu-positioning.ts`, `src/features/chat/chat-list.tsx`).
- [x] **CHAT-MENU-02 (`P0`)**: دعم أرشفة/إلغاء أرشفة المحادثة وتثبيت/إلغاء تثبيت المحادثة عبر مزامنة الخادم مع GOWA (`POST /chat/:jid/archive` و`POST /chat/:jid/pin`) وحفظ حالة التثبيت والترتيب العلوي والأرشفة في `SQLite` وعرض صف «المؤرشفة» أعلى قائمة المحادثات (`server/db.ts`, `server/routes/unified-inbox.ts`, `server/services/unified-chats-service.ts`).
- [x] **CHAT-MENU-03 (`P1`)**: إضافة قائمة فرعية لكتم إشعارات المحادثة (`8 ساعات` / `أسبوع واحد` / `دائمًا` / `إلغاء الكتم`) وربطها بمحرك التنبيهات الصوتي والمتصفح في `AppShell` و`notifications.ts`، مع خيار تحديد كغير مقروء / مقروء (`user_chat_read_states.manual_unread`) وإضافة/إزالة من المفضلة (`user_chat_preferences`) وتصفية المفضلة (`server/db.ts`, `src/lib/notifications.ts`, `src/components/layout/app-shell.tsx`).
- [x] **CHAT-MENU-04 (`P1`)**: بناء قوائم التصنيف المخصصة (`Add to list` — `chat_lists` و`chat_list_items`) مع إنشاء القوائم وتبديل عضوية المحادثة والتصفية بها، بالإضافة إلى حظر/إلغاء حظر المحادثة محليًا داخل Gowa-Lite (`is_blocked` لمنع الإرسال بـ `403 CHAT_BLOCKED`)، ومسح المحادثة (`cleared_before_ms`)، وحذف المحادثة (`deleted_before_ms`) مع محاورات التأكيد وضوابط الصلاحيات (`chats:write`, `chats:revoke`).
- [x] **TEST-CHAT-MENU-01 (`P1`)**: اختبارات وحدة وتكامل في `tests/chat-row-menu.test.ts` تغطي التموضع، الأرشفة والتثبيت، الكتم وإسكات التنبيهات، التحديد كغير مقروء، المفضلة والقوائم، الحظر ومنع الإرسال، والمسح/الحذف وضوابط الصلاحيات.

</details>
