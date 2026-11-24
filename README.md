# gowa-lite — صندوق واتساب الموحد

واجهة ويب موحدة وخادم وسيط (`Express` + `WebSocket` + `node:sqlite`) لإدارة عدة أجهزة واتساب عبر بوابة **GOWA (go-whatsapp-web-multidevice)**، مع صندوق وارد موحد، تتبع حالة القراءة لكل مستخدم، ملاحظات داخلية، رسائل مجدولة، وإدارة الحسابات والمجموعات.

---

## المتطلبات

- **Node.js `>= 22.6`** (تم التحقق على `v22.23.5` لتشغيل `node server.ts` مباشرة عبر Type Stripping واستخدام `node:sqlite`).
- **npm** لتثبيت الاعتماديات وبناء الواجهة.
- خادم **GOWA** متاح عبر HTTP/HTTPS وWebSocket للربط الفعلي مع أجهزة واتساب.

---

## متغيرات البيئة

انسخ `.env.example` أو اضبط المتغيرات التالية قبل التشغيل:

| المتغير | الافتراضي | الوصف |
| :--- | :--- | :--- |
| `PORT` | `3000` | المنفذ الذي يستمع عليه الخادم (`0.0.0.0`). |
| `NODE_ENV` | `development` | اضبطه إلى `production` لتقديم حزمة `dist/` الساكنة بدل خادم Vite التطويري. |
| `ADMIN_PASSCODE` | *(فارغ)* | رمز مرور اختياري لتخطي معالج الإعداد الأولي (`/api/auth/setup`) وتفعيل الدخول الفوري لحساب `admin`. عند ضبطه يُغلق `/api/auth/setup` برمز `403`. |
| `GOWA_LITE_DB_PATH` | `./gowa-lite.db` | مسار ملف قاعدة بيانات SQLite (مفيد لعزل قاعدة البيانات في مجلد دائم أو أثناء الاختبار). |
| `GOWA_URL` | *(فارغ)* | رابط خادم GOWA الافتراضي (يمكن ضبطه أو تغييره من واجهة الإعدادات، وتُقدَّم إعدادات الواجهة المحفوظة عليه). |
| `GOWA_USERNAME` | *(فارغ)* | اسم مستخدم Basic Auth لخادم GOWA الافتراضي. |
| `GOWA_PASSWORD` | *(فارغ)* | كلمة مرور Basic Auth لخادم GOWA الافتراضي. |
| `GOWA_WS_QUERY_AUTH` | `false` | اضبطه إلى `true` فقط إذا كان خادم GOWA أو الوكيل يرفض ترويسة `Authorization: Basic` في اتصال WebSocket ويطلب `?authorization=`. |

---

## التثبيت والتشغيل

### 1. تثبيت الاعتماديات
```bash
npm install
```

### 2. التشغيل التطويري
```bash
npm run dev
```

### 3. البناء والتشغيل الإنتاجي
```bash
npm run build
NODE_ENV=production PORT=3000 node server.ts
```
أو عبر سكربت التشغيل المباشر:
```bash
NODE_ENV=production npm start
```

> عند ضبط `NODE_ENV=production` يقدّم الخادم واجهة `dist/index.html` المدمجة (`viteSingleFile`) وملفات `dist/assets/`، مع إبقاء جميع مسارات `/api/*` وجسر `/ws` على نفس المنفذ.

### 4. الفحص النوعي والاختبارات الآلية
```bash
npm run lint
npm test
```

---

## النسخ الاحتياطي والاستعادة (`gowa-lite.db`)

تعمل قاعدة البيانات في وضع **SQLite WAL** (`PRAGMA journal_mode = WAL;`)، ما يعني وجود ثلاثة ملفات مرتبطة أثناء التشغيل:
- `gowa-lite.db` (قاعدة البيانات الرئيسية)
- `gowa-lite.db-wal` (سجل الكتابة المسبق النشط)
- `gowa-lite.db-shm` (الذاكرة المشتركة لفهرس WAL)

> تحذير: نسخ `gowa-lite.db` وحده أثناء تشغيل الخادم دون دمج `-wal` قد ينتج نسخة غير متسقة أو ناقصة أحدث الجلسات والملاحظات.

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
2. انسخ `gowa-lite.db` مع `gowa-lite.db-wal` و`gowa-lite.db-shm` (إن وُجدت) إلى موقع النسخ الاحتياطي.

### الاستعادة
1. أوقف الخادم تمامًا.
2. احذف أي بقايا قديمة لـ `gowa-lite.db-wal` و`gowa-lite.db-shm` إذا كانت النسخة مأخوذة عبر `VACUUM INTO`.
3. انسخ ملف النسخة الاحتياطية إلى المسار المحدد في `GOWA_LITE_DB_PATH` (أو `./gowa-lite.db`).
4. أعد تشغيل الخادم وتأكد من `/api/auth/status`.
