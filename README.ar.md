# Gowa Lite — صندوق واتساب الموحد

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![GOWA](https://img.shields.io/badge/Gateway-GOWA-25D366?logo=whatsapp&logoColor=white)](https://github.com/aldinokemal/go-whatsapp-web-multidevice)

> [English version](README.md) — النسخة الإنجليزية.

واجهة ويب موحدة وخادم وسيط لإدارة عدة أجهزة واتساب من مكان واحد، عبر بوابة **GOWA (go-whatsapp-web-multidevice)** — صندوق وارد موحد، أدوار وصلاحيات مخصصة، وتقييم العميل بعد إغلاق المحادثة.

---

## المزايا

- **صندوق وارد موحد** — كل حسابات واتساب في قائمة واحدة، مع فلتر حسب الحساب.
- **دورة حياة المحادثة** — تبويبات (بانتظار / محادثاتي / مغلقة / الكل)، مع تعيين واستلام وإغلاق وإعادة فتح.
- **أدوار وصلاحيات مخصصة** — مصفوفة صلاحيات دقيقة، وتقييد كل مستخدم على حسابات واتساب معينة (`/settings/roles` و`/settings/users`).
- **تتبع حالة القراءة لكل مستخدم** — كل وكيل يرى ما قرأه هو، لا ما قرأه غيره.
- **ملاحظات داخلية** على المحادثات لا يراها العميل.
- **رسائل مجدولة** تُرسل في وقتها تلقائيًا.
- **تقييم بعد الإغلاق** — عند إغلاق محادثة فردية يُرسل طلب تقييم (1–5) على واتساب، ويُقبل أول رد رقمي خلال 48 ساعة، مع متوسط وعدد التقييمات وآخر عشرة ردود في تبويب الحساب.
- **تفاعلات لحظية** على الرسائل عبر Webhook موقّع، وكتم/تثبيت/أرشفة/حظر/مسح/حذف للمحادثات.
- **إدارة الحسابات والمجموعات والنشرات**، مع ربط الأجهزة بـ QR أو كود.
- **عربي RTL وإنجليزي LTR** — نفس الواجهة باللغتين.
- **أمان** — بيانات GOWA محفوظة على الخادم فقط، روابط تنزيل وسائط موقّعة ومحددة بالحساب والمحادثة، وكلمة مرور GOWA مشفرة (`AES-256-GCM`).

---

## لقطات من الواجهة

<!-- تُضاف هنا لقطات من التطبيق نفسه ببيانات تجريبية فقط (الدخول، الصندوق، الحسابات).
     لا تُرفع أبدًا محادثات عملاء حقيقية أو أرقام هواتف أو رموز QR أو بيانات إنتاج. -->

---

## البدء السريع

```bash
npm ci
cp .env.example .env   # ثم اضبط GOWA_URL وبيانات الدخول
npm run dev            # http://localhost:3000
```

### البناء والتشغيل الإنتاجي

```bash
npm run build
NODE_ENV=production PORT=3000 node server.ts
```

أو عبر سكربت التشغيل المباشر:

```bash
NODE_ENV=production npm start
```

> عند ضبط `NODE_ENV=production` يقدّم الخادم واجهة `dist/` المقسّمة إلى حزم منفصلة (`React.lazy` + `manualChunks`) مع ضغط غير متزامن (`compression`) والتخزين المؤقت الدائم لملفات `dist/assets/*`، وإبقاء جميع مسارات `/api/*` وجسر `/ws` على نفس المنفذ.

---

## كيف يعمل

```text
المتصفح  (React 19 + Vite + Tailwind — RTL)
   │  REST + WebSocket
الخادم   (Express + ws + node:sqlite)
   │  HTTP + WebSocket
بوابة GOWA (go-whatsapp-web-multidevice) ← أجهزة واتساب
```

الرسائل والمحادثات تعيش داخل GOWA؛ النسخة الخفيفة تخزّن فقط **الإعدادات والتفضيلات** (الأدوار، التقييمات، جهات الاتصال، الجدولة) في SQLite.

---

## المتطلبات

- **Node.js `>= 22.18`** (تم التحقق على `v22.23.5` لتشغيل `node server.ts` مباشرة عبر Type Stripping واستخدام `node:sqlite`).
- **npm** لتثبيت الاعتماديات وبناء الواجهة.
- خادم **GOWA** متاح عبر HTTP/HTTPS وWebSocket للربط الفعلي مع أجهزة واتساب.

---

## متغيرات البيئة

انسخ `.env.example` إلى `.env` أو اضبط المتغيرات التالية قبل التشغيل (يحمل الخادم `.env` تلقائيًا عبر `dotenv/config` دون استبدال متغيرات البيئة المضبوطة مسبقًا):

| المتغير | الافتراضي | الوصف |
| :--- | :--- | :--- |
| `PORT` | `3000` | المنفذ الذي يستمع عليه الخادم (`0.0.0.0`). |
| `NODE_ENV` | `development` | اضبطه إلى `production` لتقديم حزمة `dist/` الساكنة بدل خادم Vite التطويري. |
| `ADMIN_PASSCODE` | *(فارغ)* | رمز مرور اختياري لتخطي معالج الإعداد الأولي (`/api/auth/setup`) وتفعيل الدخول الفوري لحساب `admin`. عند ضبطه يُغلق `/api/auth/setup` برمز `403`. |
| `GOWA_LITE_DB_PATH` | `./gowa-lite.db` | مسار ملف قاعدة بيانات SQLite (مفيد لعزل قاعدة البيانات في مجلد دائم أو أثناء الاختبار). |
| `GOWA_SETTINGS_SECRET` | *(تلقائي)* | سر تشفير كلمة مرور GOWA في SQLite (`AES-256-GCM`). إذا تُرك فارغًا، ينشئ الخادم مفتاحًا عشوائيًا في `${GOWA_LITE_DB_PATH}.key` بصلاحية `0600`. |
| `TRUST_PROXY` | `false` | إعداد `trust proxy` في Express (`false`، `true`، عدد القفزات مثل `1`، أو نطاق IP). اضبطه عند التشغيل خلف Nginx/Cloudflare حتى يقرأ `AuthRateLimiter` عنوان العميل الحقيقي من `X-Forwarded-For` بأمان. |
| `BLOCK_PRIVATE_GOWA_URL` | `false` | اضبطه إلى `true` في البيئات العامة لمنع استخدام عناوين الشبكة الداخلية (`localhost` وRFC1918) كعنوان خادم GOWA (عناوين Cloud Metadata وLink-Local محجوبة دائمًا). |
| `ENABLE_COMPRESSION` | `true` | تفعيل ضغط الاستجابات غير المتزامن (`gzip`/`deflate`) لطلبات HTTP الأكبر من 1KB. |
| `GOWA_URL` | *(فارغ)* | رابط خادم GOWA الافتراضي (يمكن ضبطه أو تغييره من واجهة الإعدادات، وتُقدَّم إعدادات الواجهة المحفوظة عليه). |
| `GOWA_USERNAME` | *(فارغ)* | اسم مستخدم Basic Auth لخادم GOWA الافتراضي. |
| `GOWA_PASSWORD` | *(فارغ)* | كلمة مرور Basic Auth لخادم GOWA الافتراضي. |
| `GOWA_WEBHOOK_SECRET` | *(فارغ)* | مفتاح توقيع Webhook اختياري لعرض تفاعلات جهات الاتصال لحظيًا. |
| `GOWA_WS_QUERY_AUTH` | `false` | اضبطه إلى `true` فقط إذا كان خادم GOWA أو الوكيل يرفض ترويسة `Authorization: Basic` في اتصال WebSocket ويطلب `?authorization=`. |

---

## الفحص النوعي والاختبارات

```bash
npm run lint
npm run build
npm test
npm run verify:live   # يتطلب بوابة GOWA حقيقية مضبوطة
```

### أحداث واتساب اللحظية

اضبط `GOWA_WEBHOOK_SECRET` على Gowa Lite و`WHATSAPP_WEBHOOK_SECRET` بنفس القيمة على البوابة. أضف العنوان الكامل لـ`/api/webhooks/gowa` إلى `WHATSAPP_WEBHOOK`، واضبط `WHATSAPP_WEBHOOK_EVENTS=message,message.reaction,message.edited,message.revoked,message.deleted`. إذا كانت للأجهزة عناوين Webhook منفصلة، فعّل `WHATSAPP_WEBHOOK_DEVICE_MERGE_GLOBAL=true` لإرسال الأحداث إلى العنوان العام أيضًا. يحتاج Gowa Lite معرّف مصدر موثوقًا لكل حدث. لو اتصال WebSocket في إصدار بوابتك بيرسل أحداثًا مشتركة من غير تحديد الحساب، استخدم الـWebhook الموقّع للتحديث اللحظي. [إعداد Webhooks في GOWA](https://github.com/aldinokemal/go-whatsapp-web-multidevice#webhooks)

روابط تنزيل الوسائط موقّعة ومحددة بالحساب والمحادثة، وتُراجع الصلاحيات عند استخدامها. الحد الأقصى لاستجابة GOWA هو 16 MiB لطلبات JSON و64 MiB للملفات. مهلة الاتصال تشمل قراءة الرد بالكامل.

### تقييم الخدمة بعد إغلاق المحادثة

افتح **الحسابات**، واختر حساب واتساب، ثم افتح تبويب **التقييمات** وفعّل إرسال طلب التقييم. الإعداد مستقل لكل حساب ومعطّل افتراضيًا. عند إغلاق محادثة فردية، يرسل التطبيق طلبًا واحدًا على واتساب ويقبل أول رد رقمي من ١ إلى ٥ خلال ٤٨ ساعة. يظهر المتوسط وعدد التقييمات وآخر عشرة ردود في تبويب الحساب. التقييم يبقي المحادثة مغلقة، ورسائل الدعم العادية تتبع سلوك إعادة الفتح.

لاستقبال التقييمات لحظيًا، استخدم إعداد الـWebhook أعلاه مع حدث `message`. يمكن أيضًا تسجيل الرد عند مزامنة سجل رسائل الحساب. إيقاف الميزة يوقف الطلبات الجديدة، وتظل الردود على الطلبات المرسلة مقبولة خلال مدتها.

---

## بنية المشروع

| المسار | المحتوى |
| :--- | :--- |
| `src/pages/` | الشاشات (الدخول، الصندوق، الحسابات، المجموعات، الأدوار، المستخدمون، الإعدادات) |
| `src/features/` | واجهات كل نطاق (محادثات، حسابات، مجموعات، جدولة، صلاحيات) |
| `src/components/` | مكونات مشتركة (`ui/`، التخطيط) |
| `src/api/` و`src/lib/` | طلبات مكتوبة الأنواع، وأدوات مشتركة |
| `server.ts` | نقطة دخول الخادم (Express + جسر WebSocket) |
| `server/routes/` و`server/services/` | المعالجات ومنطق الأعمال |
| `server/db.ts` | مخطط SQLite والاستعلامات |
| `shared/` | قواعد نقية مشتركة بين الواجهة والخادم |
| `tests/` | اختبارات `node:test` (بما فيها اختبارات تكامل بخوادم GOWA وهمية) |

اقرأ [`AGENTS.md`](AGENTS.md) قبل أي تعديل — فيه قواعد المستودع الكاملة. حالة التنفيذ التفصيلية في [`checklist.md`](checklist.md)، والتصميم المعماري في [`plan.md`](plan.md).

---

## النسخ الاحتياطي والاستعادة (`gowa-lite.db`)

تعمل قاعدة البيانات في وضع **SQLite WAL** (`PRAGMA journal_mode = WAL;`)، ما يعني وجود ثلاثة ملفات مرتبطة أثناء التشغيل، بالإضافة إلى ملف مفتاح التشفير إذا لم يُضبط `GOWA_SETTINGS_SECRET`:
- `gowa-lite.db` (قاعدة البيانات الرئيسية)
- `gowa-lite.db-wal` (سجل الكتابة المسبق النشط)
- `gowa-lite.db-shm` (الذاكرة المشتركة لفهرس WAL)
- `gowa-lite.db.key` (مفتاح التشفير التلقائي لكلمة مرور GOWA في جدول `settings`)

> تحذير:
> 1. نسخ `gowa-lite.db` وحده أثناء تشغيل الخادم دون دمج `-wal` قد ينتج نسخة غير متسقة أو ناقصة أحدث الجلسات والملاحظات.
> 2. إذا لم تضبط `GOWA_SETTINGS_SECRET`، احتفظ بنسخة من `gowa-lite.db.key` في مكان آمن بجانب النسخة الاحتياطية حتى يمكن فك تشفير كلمة مرور GOWA بعد الاستعادة.

### الطريقة الآمنة للنسخ الاحتياطي (أثناء التشغيل أو التوقف)

**الخيار أ — نسخ متسق حي عبر SQLite `VACUUM INTO` (لا يتطلب إيقاف الخادم):**
```bash
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.GOWA_LITE_DB_PATH || "./gowa-lite.db");
db.exec("VACUUM INTO \"./gowa-lite.backup.db\"");
'
```

**الخيار ب — إيقاف الخادم ثم نسخ الملفات:**
1. أوقف عملية `node server.ts` (`SIGTERM` يغلق الجسر والخادم بانتظام).
2. انسخ `gowa-lite.db` مع `gowa-lite.db-wal` و`gowa-lite.db-shm` و`gowa-lite.db.key` (إن وُجدت) إلى موقع النسخ الاحتياطي.

### الاستعادة
1. أوقف الخادم تمامًا.
2. احذف أي بقايا قديمة لـ `gowa-lite.db-wal` و`gowa-lite.db-shm` إذا كانت النسخة مأخوذة عبر `VACUUM INTO`.
3. انسخ ملف النسخة الاحتياطية (وملف `.key` إن استُخدم) إلى المسار المحدد في `GOWA_LITE_DB_PATH` (أو `./gowa-lite.db`).
4. أعد تشغيل الخادم وتأكد من `/api/auth/status`.

---

## الترخيص

ملكية خاصة — جميع الحقوق محفوظة. راجع [LICENSE](LICENSE) (النص الإنجليزي هو المعتمد) و[LICENSE.ar.md](LICENSE.ar.md) (الترجمة العربية). الاستخدام التجاري يتطلب شراء رخصة من صاحب الحقوق.

---

## الحالة وخارطة الطريق

المشروع مكتمل وظيفيًا وفق قائمة المراجعة في [`checklist.md`](checklist.md). المتبقي: التحقق الحي أمام بوابة GOWA حقيقية (`npm run verify:live`)، والتحقق من البناء على Linux.
