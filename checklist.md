# قائمة المراجعة والتطوير — gowa-lite

> المرجع الهندسي المعتمد: `affaan-m/ECC` (`skills/coding-standards/SKILL.md` — commit `d29cf651c795869f733669c33e3d33dfd8307d10`)
> المرجع الوظيفي: `compnew2006/gowa-ui` | مرجع التصميم: `pbakaus/impeccable` (`v4.10.0`)
> تاريخ الإنشاء: `2026-11-23` | تاريخ التحديث: `2026-11-24`
> الحالة الحالية: **33/45 بندًا مكتملًا** — المتبقي هو التحقق الحي أمام خادم GOWA (`PROD-03`) ومراحل التطوير 4–7 (`11` بندًا).

---

## العمل المتبقي

### التحقق الإنتاجي الحي

- [ ] **PROD-03 (`P2`)**: التحقق التكاملي الحي أمام خادم GOWA حقيقي (دعم `PATCH /send/schedules/:id`، وأحداث `MESSAGE_REVOKED`، وتحديث العداد اللحظي). *يتطلب `GOWA_URL` متصلًا.*

### خارطة التطوير الجديدة

> المرجع التفصيلي: `plan.md`

#### المرحلة الرابعة: نظام الأدوار المخصصة وتقييد الحسابات (`/settings/roles` و`/settings/users`)

- [ ] **RBAC-01 (`P0`)**: إنشاء جداول `roles`, `role_permissions`, `user_device_access` في `SQLite` مع ترحيل تلقائي آمن للمستخدمين الحاليين (`admin` / `agent`) وقراءة الصلاحيات الفعالة والحسابات المسموحة داخل الجلسة (`getSessionUser`).
- [ ] **RBAC-02 (`P0`)**: تطبيق middleware الخادم `requirePermission(resource, action)` و`assertDeviceAccess(user, deviceId)` على جميع مسارات الـ API و`ws-bridge.ts` (Fail-Closed)، وإضافة مسارات `/api/roles`, `/api/permissions` وتحديث `/api/users` لحماية آخر مسؤول نشط وإبطال الجلسات عند التعطيل.
- [ ] **RBAC-03 (`P1`)**: بناء واجهتَي `/settings/roles` (`PermissionMatrix` بمربعات ثلاثية الحالة وحارس تغييرات غير محفوظة) و`/settings/users` (تعيين الدور + تحديد حسابات واتساب المسموحة + إعادة توجيه `/users`) وربط `RequirePermission` في `App.tsx` و`AppShell`.

#### المرحلة الخامسة: محرك دورة حياة المحادثة وتعيين جهات الاتصال (`Assign Contact` & `Lifecycle`)

- [ ] **LIFECYCLE-01 (`P0`)**: إنشاء جدولي `chat_assignments` و`chat_lifecycle_events` في `SQLite` وخدمة `server/services/chat-lifecycle.ts` مع معاملات `BEGIN IMMEDIATE` للاستلام الذري (`409 Conflict` عند التسابق) وإعادة الفتح التلقائي للمحادثات المغلقة عند ورود رسالة من العميل.
- [ ] **LIFECYCLE-02 (`P0`)**: إضافة مسارات الخادم `claim`, `assign`, `release`, `close`, `reopen`, `bulk-lifecycle`, `assignable-agents` (مع عداد المحادثات المفتوحة لكل وكيل)، وإعداد سياسة المعاينة/القفل والاستلام التلقائي عند الرد (`/api/settings/inbox-policy`) مع بث الأحداث عبر WebSocket.
- [ ] **LIFECYCLE-03 (`P1`)**: بناء مكون `AssignChatDialog` الموحد (تعيين/تحويل/إلغاء تعيين مع حمل الوكلاء)، أزرار دورة الحياة في `MessageViewHeader`، قفل الـ Composer عند الإغلاق أو القفل الصارم، وعرض رسائل النظام الزمنية داخل `MessageView`.

#### المرحلة السادسة: تبويبات `All - Me - Pending - Closed` والعدادات الخادمية في `/chats`

- [ ] **CHAT-TABS-01 (`P0`)**: تحديث `GET /api/unified/chats` لدعم `tab=all|me|pending|closed` وإرجاع `tab_counts` الدقيقة من الخادم مع ترقيم خادمي مباشر لتبويب `closed` من `chat_assignments` وإثراء العناوين والتوقيت من الكاش.
- [ ] **CHAT-TABS-02 (`P1`)**: إضافة شريط التبويبات الأربعة (`role="tablist"` + تنقل الأسهم + `tabular-nums`) في `ChatList` مع تمييز سلوك `Me` للمشرفين عن الوكيل، وإظهار المالك/الحالة بنمط `Zero-Pill`، ودعم التحديد الجماعي للإغلاق/التحرير.
- [ ] **CHAT-TABS-03 (`P2`)**: تضييق تنبيهات الصوت والمتصفح في `notifications.ts` لتصل للوكيل فقط على الحسابات المسموحة والمحادثات المتاحة له (`pending` أو مسندة إليه).

#### المرحلة السابعة: صقل الواجهة (`Impeccable`) والاختبارات الشاملة

- [ ] **DESIGN-IMPECCABLE-01 (`P1`)**: مراجعة وصقل شاشات `/settings/roles` و`/settings/users` و`/chats` وفق قواعد `pbakaus/impeccable` (`mode-operate` و`craft-floor`): التباين WCAG AA، `Zero-Pill`، حالة التركيز والتحميل والفراغ، ودعم RTL/LTR الكامل.
- [ ] **TEST-PHASE5-01 (`P0`)**: كتابة اختبارات شاملة في `tests/phase5.test.ts` (الصلاحيات، تقييد الحسابات، التسابق `409 Conflict` في `Claim`، الترقيم في `Closed`، وإعادة فتح العميل التلقائية) والتحقق من `npm test` و`tsc --noEmit` و`npm run build`.

---

## سجل الأعمال المكتملة

<details>
<summary>عرض تفاصيل المراحل المكتملة (`33/33`)</summary>

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

</details>
