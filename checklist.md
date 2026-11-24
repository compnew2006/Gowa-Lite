# قائمة المراجعة والتحسين الهندسي — gowa-lite

> المرجع الهندسي المعتمد: `affaan-m/ECC` (`skills/coding-standards/SKILL.md` — commit `d29cf651c795869f733669c33e3d33dfd8307d10`)
> تاريخ الإنشاء: `2026-11-23`
> حالة التقدم: **اكتملت المرحلة الأولى بالكامل (`12/12` بند)** — تم التحقق عبر `npm test` (8/8 نجاح)، `npm run lint` (`tsc --noEmit`)، بناء الإنتاج (`compile_applet`)، وفحص المسارات الحية على المنفذ `3000`.

---

## المرحلة الأولى: الاحتواء الأمني، تثبيت الجلسة، إصلاح محرك المزامنة/غير المقروء/المجدولة، وتحديث شريط المحادثات

### 1. الأمان والحدود الحرجة للتشغيل
- [x] **F-01 (`P0`)**: منع تسريب كلمة مرور خادم `gowa` المحفوظة عبر `POST /api/settings/gowa/test` عند تمرير `gowa_url` جديد مختلف في `origin` عن العنوان المحفوظ (`server/security.ts`, `server.ts`).
- [x] **F-02 (`P1`)**: الحفاظ على جلسة المستخدم عند إعادة تحميل الصفحة (`F5`) باستخدام كوكي `HttpOnly` آمن (`SameSite=None; Secure; Partitioned` في HTTPS، و`SameSite=Lax` في HTTP المحلي) مع حماية CSRF (`Origin` / `X-Requested-With`) ودعم `Authorization: Bearer` المتزامن دون تخزين أي tokens في `localStorage` أو `sessionStorage` (`server/security.ts`, `server.ts`, `src/lib/http.ts`).
- [x] **F-03 (`P1`)**: إضافة Rate Limiter (`AuthRateLimiter`) على `/api/auth/login` و`/api/auth/setup` لمنع التخمين (إرجاع `429` مع `Retry-After`)، وتحويل `scryptSync` إلى `crypto.scrypt` غير المتزامن حتى لا يتجمد Event Loop (`server/security.ts`, `server/db.ts`, `server.ts`).
- [x] **F-09 (`P2`)**: حماية `decodeURIComponent` لمعلمات المسارات (`deviceId`, `jid`, `id`, `messageId`) عبر `decodeRouteParam` + معالج أخطاء Express JSON لمسارات `/api/*` بحيث تُرجع JSON `400 VALIDATION_ERROR` بدل إسقاط الطلب بصفحة HTML 500/400 `URIError` (`server/security.ts`, `server.ts`).

### 2. محرك عدم القراءة المعزول، الرسائل المحذوفة، وإعادة الجدولة
- [x] **F-04 (`P1`)**: إصلاح `syncChatWatermarks` ومسار `catchup`: عدم مسح علامة التحديث قبل نجاح جلب الرسائل (عمود `needs_catchup` + `catchup_prev_ms` في `chat_sync_state`)، ومعالجة أكثر من 10 محادثات متأخرة عبر الدورات المتتالية دون ضياع `unread_count`، وتوحيد `chat_id` بدون لاحقة `@s.whatsapp.net` في أحداث WebSocket (`server/db.ts`, `server.ts`).
- [x] **F-05 (`P1`)**: إصلاح أداء `getUnreadCountsForUser`: استبدال تحميل جميع صفوف `cached_messages` في ذاكرة Node باستعلام SQL تجميعي (`LEFT JOIN user_chat_read_states` + `COUNT(*)`) مع فهرس جزئي مناسب (`idx_cached_messages_unread_active`) (`server/db.ts`).
- [x] **F-06 (`P1`)**: إصلاح انزياح التصفح (`Pagination Offset Drift`) عند حقن الرسائل المحذوفة: تمرير `live_total` و`raw_count` و`next_offset` الفعلي من GOWA في `pagination` وتحديث `getNextPageParam` في `MessageView` حتى لا تُتخطى رسائل حية عند التمرير للأعلى (`server/db.ts`, `server.ts`, `src/api/types.ts`, `src/features/chat/message-view.tsx`).
- [x] **F-07 (`P1`)**: إصلاح سباق `markAsRead`: إضافة `pendingMarkReadRef` لتنفيذ إعادة التحديد كمقروء تلقائيًا إذا وصلت رسالة جديدة أثناء وجود طلب `/read` قيد التنفيذ (`src/features/chat/message-view.tsx`).
- [x] **F-08 (`P1`)**: تأمين المسار الاحتياطي لإعادة الجدولة (`PATCH /api/unified/chats/:deviceId/:jid/schedules/:id`): البحث عبر صفحات `/send/schedules` حتى 500 عنصر، الحفاظ على حالة `paused` للجدولة المعاد إنشاؤها، وتنفيذ تراجع تعويضي وإرجاع خطأ `502 RESCHEDULE_CANCEL_FAILED` عند فشل إلغاء الجدولة القديمة (`server.ts`).

### 3. واجهة شريط المحادثات الجانبي (متطلبات المستخدم المباشرة)
- [x] **UX-01 (`P1`)**: إضافة ويدجت/مؤشر واضح في شريط المحادثات الجانبي (`ChatList` وفي شريط التنقل `AppShell`) يعرض عدد الرسائل غير المقروءة **للمستخدم المسجَّل دخوله حاليًا** بشكل معزول (يظهر دائمًا مع اسم المستخدم ويعرض `0` أو العدد الفعلي مع إمكانية النقر لتصفية غير المقروءة في العرض الموحد وSplit View، وشارة عدد على أيقونة المحادثات في `AppShell`) (`src/features/chat/chat-list.tsx`, `src/pages/chats.tsx`, `src/components/layout/app-shell.tsx`, `src/lib/i18n.ts`).
- [x] **UX-02 (`P1`)**: تطويل/توسيع الويدجت الذي يعرض اسم الحساب القادم منه الرسالة في بطاقة المحادثة (`chat-list.tsx`) وقائمة اختيار الحساب (`AccountMultiSelect`) عبر إزالة القيد الضيق `max-w-[104px]` واستبداله بـ `min-w-0 max-w-[72%]` و`max-w-[220px]` ليتمدد مع عرض الشريط الجانبي ولا يقطع أسماء الحسابات الطويلة (`src/features/chat/chat-list.tsx`).

### 4. اختبارات التحقق للمرحلة الأولى
- [x] **TEST-01 (`P1`)**: إضافة سكريبت `test` في `package.json` وكتابة اختبارات آلية معزولة (`tests/phase1.test.ts` عبر `tsx --test` مع قاعدة بيانات مؤقتة `GOWA_LITE_DB_PATH`) تغطي: عزل عداد غير المقروء لكل مستخدم، استكمال `needs_catchup` لأكثر من 10 محادثات، دمج الرسائل المحذوفة وفصل `rawCount`/`injectedCount`، تشفير/تحقق كلمة المرور غير المتزامن، وفحوصات الأمان (`decodeRouteParam`، `AuthRateLimiter`، CSRF، وحماية `gowa/test`).

---

## المرحلة الثانية: التبسيط المعماري، توحيد الجدولة، جودة النوعية، ومراجعة الصفحات المتبقية

- [ ] **ARCH-01 (`P2`)**: تقسيم `server.ts` (3037 سطر) إلى وحدات منظمة (`server/middleware/*`, `server/routes/*`, `server/services/*`) وجعل استيراد `vite` ديناميكيًا داخل فرع التطوير فقط.
- [ ] **ARCH-02 (`P2`)**: تفكيك `MessageView` (1134 سطر) و`ChatContextDrawer` (1044 سطر) إلى مكونات أصغر واضحة المسؤولية (`< 50` سطرًا للدالة قدر الإمكان).
- [ ] **DRY-01 (`P2`)**: توحيد منطق ونموذج إنشاء/تعديل الجدولة (`F-10`) بين `schedule-dialog.tsx` و`scheduled.tsx` و`chat-context-drawer.tsx`، وتوحيد حد الوقت المستقبلي على الخادم في كلا مساري الجدولة (`/unified/chats/.../schedules` و`/devices/:deviceId/schedules`).
- [ ] **TS-01 (`P2`)**: تفعيل `"strict": true` في `tsconfig.json` وتقليل التحويلات القسرية (`as unknown as`) في `server/db.ts`.
- [ ] **DEPS-01 (`P2`)**: تنظيف `package.json` من الحزم غير المستخدمة (`@google/genai`, `motion`) والتحقق من سلوك `viteSingleFile` في الإنتاج.
- [ ] **WS-01 (`P2`)**: مراجعة تمرير اعتماد GOWA في WebSocket (`?authorization=` في `server/ws-bridge.ts:182`) ونقله للترويسة إذا دعمه خادم GOWA المستهدف.
- [ ] **AUDIT-01 (`P2`)**: فحص صفحات الإدارة غير المفحوصة بعد (`accounts.tsx`, `account.tsx`, `groups.tsx`, `users.tsx`, `misc.tsx`) والتأكد من عدم وجود ثغرات أو تكرار بها.

---

## المرحلة الثالثة: بوابة الجودة والتشغيل الإنتاجي

- [ ] **PROD-01 (`P1`)**: اختبار بناء الإنتاج الكامل (`npm run build` ثم `NODE_ENV=production node server.ts`) والتحقق من تقديم الواجهة وجميع مسارات `/api/*` و`/ws`.
- [ ] **PROD-02 (`P2`)**: إضافة `README.md` يوثق متغيرات البيئة (`ADMIN_PASSCODE`, `GOWA_LITE_DB_PATH`, `PORT`), خطوات التشغيل، والنسخ الاحتياطي لقاعدة `gowa-lite.db`.
- [ ] **PROD-03 (`P2`)**: التحقق التكاملي الحي أمام خادم GOWA حقيقي (دعم `PATCH /send/schedules/:id`، وأحداث `MESSAGE_REVOKED`، وتحديث العداد اللحظي).
