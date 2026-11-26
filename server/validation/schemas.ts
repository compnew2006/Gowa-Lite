import {z, type ZodType} from 'zod';
import {GowaError} from '../errors.ts';

export function parseSchema<T>(
  schema: ZodType<T>,
  input: unknown,
  fallbackMessage = 'بيانات الطلب غير صالحة',
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new GowaError(400, 'VALIDATION_ERROR', firstIssue?.message || fallbackMessage);
  }
  return result.data;
}

export function parsePositiveIntId(raw: string, label = 'المعرّف'): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', `${label} غير صالح`);
  }
  return parsed;
}

export const usernameSchema = z
  .string({error: 'اسم الدخول يجب أن يكون بين 3 و 32 حرفًا إنجليزيًا أو رقمًا'})
  .trim()
  .regex(/^[a-zA-Z0-9._-]{3,32}$/, {
    message: 'اسم الدخول يجب أن يكون بين 3 و 32 حرفًا إنجليزيًا أو رقمًا',
  });

export const setupAuthSchema = z.object({
  display_name: z
    .string({error: 'يرجى إدخال اسم المسؤول الكامل'})
    .trim()
    .min(2, {message: 'يرجى إدخال اسم المسؤول الكامل'}),
  username: usernameSchema,
  password: z
    .string({error: 'كلمة المرور يجب أن لا تقل عن 8 أحرف'})
    .min(8, {message: 'كلمة المرور يجب أن لا تقل عن 8 أحرف'}),
  gowa_url: z.string().trim().optional().default(''),
  gowa_username: z.string().trim().optional().default(''),
  gowa_password: z.string().optional().default(''),
});

export const loginAuthSchema = z.object({
  username: z
    .string({error: 'يرجى إدخال اسم الدخول وكلمة المرور'})
    .trim()
    .min(1, {message: 'يرجى إدخال اسم الدخول وكلمة المرور'}),
  password: z
    .string({error: 'يرجى إدخال اسم الدخول وكلمة المرور'})
    .min(1, {message: 'يرجى إدخال اسم الدخول وكلمة المرور'}),
});

export const updatePreferencesSchema = z
  .object({
    theme: z
      .enum(['light', 'dark', 'system'], {message: 'قيمة السمة غير صالحة'})
      .optional(),
    language: z.enum(['ar', 'en'], {message: 'قيمة اللغة غير صالحة'}).optional(),
  })
  .refine((data) => data.theme !== undefined || data.language !== undefined, {
    message: 'يرجى تحديد تفضيل للتحديث',
  });

export const updateGowaSettingsSchema = z.object({
  gowa_url: z.string().trim().optional().default(''),
  gowa_username: z.string().trim().optional().default(''),
  gowa_password: z.string().optional(),
  clear_password: z.boolean().optional(),
});

export const testGowaSettingsSchema = z.object({
  gowa_url: z.string().trim().optional(),
  gowa_username: z.string().trim().optional(),
  gowa_password: z.string().optional(),
});

export const createUserSchema = z.object({
  username: usernameSchema,
  display_name: z
    .string({error: 'الاسم الكامل مطلوب'})
    .trim()
    .min(2, {message: 'الاسم الكامل مطلوب'}),
  password: z
    .string({error: 'كلمة المرور يجب أن لا تقل عن 8 أحرف'})
    .min(8, {message: 'كلمة المرور يجب أن لا تقل عن 8 أحرف'}),
  role: z.enum(['admin', 'agent']).optional(),
  role_id: z.unknown().optional(),
  allowed_device_ids: z.unknown().optional(),
});

export const updateUserSchema = z.object({
  display_name: z.unknown().optional(),
  role: z.unknown().optional(),
  role_id: z.unknown().optional(),
  allowed_device_ids: z.unknown().optional(),
  is_active: z.boolean().optional(),
  password: z.string().optional(),
});

export const createRoleBodySchema = z.object({
  name: z
    .string({error: 'اسم الدور يجب أن يكون بين 2 و 60 حرفًا'})
    .trim()
    .min(2, {message: 'اسم الدور يجب أن يكون بين 2 و 60 حرفًا'})
    .max(60, {message: 'اسم الدور يجب أن يكون بين 2 و 60 حرفًا'}),
  description: z
    .string()
    .trim()
    .max(250, {message: 'وصف الدور يجب ألا يتجاوز 250 حرفًا'})
    .optional()
    .default(''),
  permissions: z.unknown(),
  is_default: z.boolean().optional(),
});

export const updateRoleBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  permissions: z.unknown().optional(),
  is_default: z.boolean().optional(),
});

export const sendTextMessageSchema = z.object({
  message: z
    .string({error: 'نص الرسالة مطلوب'})
    .trim()
    .min(1, {message: 'نص الرسالة مطلوب'}),
  reply_message_id: z.string().trim().optional(),
});

export const reactionBodySchema = z.object({
  emoji: z.string().trim().max(32, {message: 'صيغة التفاعل غير صالحة'}).optional().default(''),
});

export const closeRatingSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    prompt_message: z
      .string()
      .max(1000, {message: 'نص رسالة التقييم طويل جدًا (الحد الأقصى 1000 حرف)'})
      .optional(),
  })
  .refine((data) => data.enabled !== undefined || data.prompt_message !== undefined, {
    message: 'يرجى تحديد إعداد واحد على الأقل للتحديث',
  });

export const callAutoRejectSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    reply_message: z
      .string()
      .max(1000, {message: 'نص رسالة الرد طويل جدًا (الحد الأقصى 1000 حرف)'})
      .optional(),
    reset_message: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.enabled !== undefined ||
      data.reply_message !== undefined ||
      data.reset_message === true,
    {
      message: 'يرجى تحديد إعداد واحد على الأقل للتحديث',
    },
  );

export const dailyResetSettingsSchema = z.object({
  enabled: z.boolean({error: 'حالة التفعيل مطلوبة'}),
  reset_hour: z
    .number({error: 'ساعة إعادة التعيين مطلوبة'})
    .int({message: 'ساعة إعادة التعيين يجب أن تكون رقمًا صحيحًا'})
    .min(0, {message: 'ساعة إعادة التعيين يجب أن تكون بين 0 و 23'})
    .max(23, {message: 'ساعة إعادة التعيين يجب أن تكون بين 0 و 23'}),
  timezone: z
    .string()
    .trim()
    .max(100, {message: 'اسم المنطقة الزمنية طويل جدًا'})
    .optional()
    .default('')
    .refine(
      (tz) => {
        if (!tz) return true;
        try {
          new Intl.DateTimeFormat('en-US', {timeZone: tz});
          return true;
        } catch {
          return false;
        }
      },
      {message: 'المنطقة الزمنية غير صالحة (استخدم صيغة IANA مثل Asia/Riyadh)'},
    ),
});

export const conversationNoteCreateSchema = z.object({
  content: z
    .string({error: 'نص الملاحظة مطلوب'})
    .trim()
    .min(1, {message: 'نص الملاحظة مطلوب'})
    .max(4000, {message: 'الملاحظة طويلة جدًا (الحد الأقصى 4000 حرف)'}),
  is_pinned: z.boolean().optional(),
});

export const conversationNotePatchSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, {message: 'نص الملاحظة مطلوب'})
      .max(4000, {message: 'الملاحظة طويلة جدًا (الحد الأقصى 4000 حرف)'})
      .optional(),
    is_pinned: z.boolean().optional(),
  })
  .refine((data) => data.content !== undefined || data.is_pinned !== undefined, {
    message: 'لا توجد تعديلات لحفظها',
  });

export const lifecycleActionBodySchema = z.object({
  cached_title: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  assigned_user_id: z.unknown().optional(),
  assign_to_self: z.boolean().optional(),
});

export const chatArchiveBodySchema = z.object({
  archived: z.boolean({error: 'قيمة الأرشفة مطلوبة'}),
});

export const chatPinBodySchema = z.object({
  pinned: z.boolean({error: 'قيمة التثبيت مطلوبة'}),
});

export const chatMuteBodySchema = z.object({
  duration: z.enum(['8h', '1w', 'always', 'unmute'], {
    error: 'مدة كتم الإشعارات غير صالحة',
  }),
});

export const chatUnreadBodySchema = z.object({
  unread: z.boolean({error: 'قيمة حالة القراءة مطلوبة'}),
});

export const chatFavouriteBodySchema = z.object({
  favourite: z.boolean({error: 'قيمة المفضلة مطلوبة'}),
});

export const chatBlockBodySchema = z.object({
  blocked: z.boolean({error: 'قيمة الحظر مطلوبة'}),
});

export const chatListCreateSchema = z.object({
  name: z
    .string({error: 'اسم القائمة مطلوب'})
    .trim()
    .min(1, {message: 'اسم القائمة مطلوب'})
    .max(60, {message: 'اسم القائمة يجب ألا يتجاوز 60 حرفًا'}),
});

export const chatListsAssignSchema = z.object({
  list_ids: z
    .array(z.number().int().positive(), {error: 'قائمة المعرّفات غير صالحة'})
    .max(50, {message: 'الحد الأقصى 50 قائمة للمحادثة'}),
});

