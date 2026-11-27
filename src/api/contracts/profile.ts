// Account Profile & Lookups
export type PrivacyResponse = Record<string, string | undefined>;

export interface AccountContact {
  jid: string;
  name: string;
}

export interface UserInfoResponse {
  verified_name?: string;
  status?: string;
  picture_id?: string;
  devices?: Array<{
    Device: string;
    DeviceID: number;
    DomainType?: number;
    Index?: number;
  }>;
}

export interface AvatarResponse {
  url: string;
  id: string;
  type: string;
}

export interface CheckResponse {
  is_on_whatsapp: boolean;
}

export interface BusinessProfileResponse {
  jid: string;
  email?: string;
  address?: string;
  categories?: Array<{id: string; name: string}>;
  profile_options?: Record<string, string>;
  business_hours_timezone?: string;
  business_hours?: Array<{
    day_of_week: string;
    mode: string;
    open_time: string;
    close_time: string;
  }>;
}
