export type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'logged_in';

export interface RegistryDevice {
  id: string;
  phone_number?: string;
  display_name?: string;
  alias?: string;
  resolved_name?: string;
  state: DeviceState;
  jid?: string;
  created_at: string;
}

export interface AccountSummary {
  id: string;
  display_name: string;
  phone_number: string | null;
  state: DeviceState;
}

export interface AssignableAccountSummary extends AccountSummary {
  jid?: string | null;
  source?: 'live' | 'cached';
}

export interface AssignableAccountsCatalog {
  gowa_reachable: boolean;
  error_message?: string;
  accounts: AssignableAccountSummary[];
}

export interface LoginQr {
  device_id: string;
  qr_link: string;
  qr_duration: number;
}

export interface PairCode {
  device_id: string;
  pair_code: string;
}

export interface DeviceStatus {
  device_id: string;
  is_connected: boolean;
  is_logged_in: boolean;
}

export interface GowaSettings {
  gowa_url: string;
  gowa_username: string;
  has_password: boolean;
}

export interface GowaProbeResult {
  ok: boolean;
  devicesCount: number;
  error?: string;
  code?: string;
  info?: {
    version: string;
    os: string;
    base_path: string;
    max_file_size: number;
    max_video_size: number;
    max_image_size: number;
  };
}
