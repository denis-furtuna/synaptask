// Types for supabase/migrations/*.sql, in the shape `supabase gen types typescript` produces.
// Regenerate after schema changes:  supabase gen types typescript --linked > supabase/functions/_shared/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Base = { id: string; user_id: string; created_at: string; updated_at: string; deleted_at: string | null };
type Ins<T> = { [K in keyof T]?: T[K] };

type CategoryRow = Base & { name: string; color: string; position: number };
type TaskRow = Base & {
  category_id: string | null; idea_id: string | null; title: string; notes: string; priority: number;
  due_date: string | null; due_time: string | null; remind_at: string | null; reminded_at: string | null;
  recurrence: Json | null; subtasks: Json; completed_at: string | null; last_completed_at: string | null;
  source: string; position: number;
};
type IdeaRow = Base & { title: string; notes: string; stage: string; tags: Json; links: Json; position: number };
type VaultItemRow = Base & { ciphertext: string; iv: string; remind_at: string | null; reminded_at: string | null };
type VaultRow = { user_id: string; record: Json; public_key: Json; created_at: string; updated_at: string };
type InboxRow = { id: string; user_id: string; sealed: Json; created_at: string; updated_at: string };
type PushRow = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; created_at: string; updated_at: string };
type GrantRow = { user_id: string; sealed_key: Json; expires_at: string; created_at: string; updated_at: string };
type RequestRow = { user_id: string; requested_at: string; created_at: string; updated_at: string };
type SettingsRow = { user_id: string; timezone: string; email_reminders: boolean; push_reminders: boolean; created_at: string; updated_at: string };
type TrustedRow = { user_id: string; client_id: string; name: string; redirect_uri: string; created_at: string; updated_at: string };

type Table<R> = { Row: R; Insert: Ins<R>; Update: Ins<R>; Relationships: [] };

export type Database = {
  __InternalSupabase: { PostgrestVersion: '13' };
  public: {
    Tables: {
      categories: Table<CategoryRow>;
      tasks: Table<TaskRow>;
      ideas: Table<IdeaRow>;
      vault_items: Table<VaultItemRow>;
      vaults: Table<VaultRow>;
      vault_inbox: Table<InboxRow>;
      push_subscriptions: Table<PushRow>;
      user_settings: Table<SettingsRow>;
      work_grants: Table<GrantRow>;
      work_access_requests: Table<RequestRow>;
      trusted_clients: Table<TrustedRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      vault_public_key: { Args: Record<PropertyKey, never>; Returns: Json };
      work_grant_active: { Args: Record<PropertyKey, never>; Returns: boolean };
      oauth_client_trusted: { Args: Record<PropertyKey, never>; Returns: boolean };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
