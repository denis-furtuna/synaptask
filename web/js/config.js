// Public configuration. These three values are safe to commit: the publishable
// key only works together with the Row Level Security rules in the database.
// Leave them empty to run in LOCAL MODE (data stays in this browser only).
export const CONFIG = {
  supabaseUrl: '',      // e.g. https://abcdefghijkl.supabase.co
  supabaseKey: '',      // the "publishable" (anon) key, never the secret key
  vapidPublicKey: '',   // from tools/vapid-keys.html, for push notifications
};
