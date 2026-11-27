import type {AccountSummary, DeviceState} from '@/api/contracts/accounts';
import type {NewsletterMetadata} from '@/api/contracts/misc';

// Groups
export interface GroupParticipant {
  JID: string;
  PhoneNumber?: string;
  LID?: string;
  DisplayName?: string;
  IsAdmin: boolean;
  IsSuperAdmin: boolean;
}

export interface MyGroup {
  JID: string;
  OwnerJID?: string;
  Name: string;
  Topic?: string;
  IsLocked?: boolean;
  IsAnnounce?: boolean;
  IsEphemeral?: boolean;
  IsJoinApprovalRequired?: boolean;
  GroupCreated?: string;
  ParticipantCount?: number;
  Participants?: GroupParticipant[];
}

export interface GroupParticipantsResult {
  group_id: string;
  name: string;
  participants: Array<{
    jid: string;
    phone_number: string;
    display_name: string;
    is_admin: boolean;
    is_super_admin: boolean;
  }>;
}

export interface ParticipantRequestEntry {
  jid: string;
  phone_number: string;
  display_name: string;
  requested_at: string;
}

export interface ParticipantStatus {
  participant: string;
  status: string;
  message: string;
}

export interface GroupInfoFromLink {
  group_id: string;
  name: string;
  topic?: string;
  created_at?: string;
  participant_count: number;
  is_locked: boolean;
  is_announce: boolean;
  is_ephemeral?: boolean;
  description?: string;
}

export interface GroupInviteLink {
  invite_link: string;
  group_id: string;
}

export interface UnifiedDirectoryAccountRef {
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
}

export interface UnifiedGroupItem {
  kind: 'group';
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
  accounts?: UnifiedDirectoryAccountRef[];
  jid: string;
  name: string;
  participant_count: number;
  unread_count?: number;
  group: MyGroup;
}

export interface UnifiedNewsletterItem {
  kind: 'newsletter';
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
  accounts?: UnifiedDirectoryAccountRef[];
  jid: string;
  name: string;
  subscribers_count: number;
  live_active: boolean;
  newsletter: NewsletterMetadata;
}

export type UnifiedDirectoryItem = UnifiedGroupItem | UnifiedNewsletterItem;

export interface UnifiedGroupsResponse {
  items: UnifiedDirectoryItem[];
  groups_count: number;
  newsletters_count: number;
  total_unread?: number;
  accounts: AccountSummary[];
  device_errors: Array<{
    device_id: string;
    display_name: string;
    message: string;
  }>;
}
