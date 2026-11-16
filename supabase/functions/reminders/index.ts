// Reminders: called every minute by pg_cron (supabase/sql/schedule_reminders.sql) with the
// project's secret key in the `apikey` header.
//
//  * Due personal tasks: a push with the title on every subscribed device, and one email
//    per user per run through Resend.
//  * Due work items: a generic "A work task is due" push. The server cannot read them.
//
// Secrets (supabase secrets set …):
//   VAPID_PRIVATE_JWK   private key from tools/keys.html (JSON)
//   VAPID_CONTACT       mailto:you@example.com   (push services may contact you about problems)
//   RESEND_API_KEY      from resend.com          (optional: no key, no email)
//   REMINDER_FROM       e.g. "Synaptask <reminders@your-domain>"  (default: Resend's test sender)
//   APP_URL             e.g. https://<you>.github.io/synaptask/   (link in emails and notifications)
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { withSupabase } from 'npm:@supabase/server@^1.9.2';

import type { Database } from '../_shared/database.types.ts';
import { sendPush as push, type PushMessage as Push, type PushTarget as Sub } from '../_shared/push.ts';

const VAPID = Deno.env.get('VAPID_PRIVATE_JWK') ?? '';
const CONTACT = Deno.env.get('VAPID_CONTACT') ?? '';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('REMINDER_FROM') ?? 'Synaptask <onboarding@resend.dev>';
const APP_URL = (Deno.env.get('APP_URL') ?? '').trim().replace(/([^/])$/, '$1/'); // '' stays ''
const RESEND_URL = Deno.env.get('RESEND_API_URL') ?? 'https://api.resend.com/emails'; // overridable for tests

const WINDOW_MS = 24 * 3600 * 1000; // reminders older than this are skipped, not sent late

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sendPush = (sub: Sub, msg: Push) => push(sub, msg, VAPID, CONTACT);

async function sendEmail(to: string, titles: { title: string; when: string }[]) {
  const subject = titles.length === 1 ? `Reminder: ${titles[0].title}` : `${titles.length} tasks are due`;
  const lines = titles.map((t) => `• ${t.title}${t.when ? ` (${t.when})` : ''}`);
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: subject.slice(0, 150),
      text: `${lines.join('\n')}\n\n${APP_URL ? `Open Synaptask: ${APP_URL}#/today\n\n` : ''}You get this because email reminders are on in Synaptask → Settings.`,
      html: `<ul>${titles.map((t) => `<li>${escHtml(t.title)}${t.when ? ` <span style="color:#666">(${escHtml(t.when)})</span>` : ''}</li>`).join('')}</ul>` +
        (APP_URL ? `<p><a href="${escHtml(APP_URL)}#/today">Open Synaptask</a></p>` : '') +
        '<p style="color:#888;font-size:12px">You get this because email reminders are on in Synaptask → Settings.</p>',
    }),
  });
  if (!res.ok) console.warn('email failed', res.status, await res.text().catch(() => ''));
}

Deno.serve(withSupabase<Database>({ auth: 'secret' }, async (_req, { supabaseAdmin: db }) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();

  // Claude's access to Work ends on time: an expired grant (the sealed vault key) must not linger.
  const { data: expired } = await db.from('work_grants').delete().lte('expires_at', nowIso).select('user_id');
  await db.from('work_access_requests').delete().lt('requested_at', since);

  // Claim due rows atomically (reminded_at is null -> now) so overlapping runs never send twice.
  const { data: tasks, error: e1 } = await db.from('tasks')
    .update({ reminded_at: nowIso })
    .is('reminded_at', null).is('completed_at', null).is('deleted_at', null)
    .lte('remind_at', nowIso).gt('remind_at', since)
    .select('id, user_id, title, due_date, due_time');
  if (e1) return Response.json({ error: e1.message }, { status: 500 });
  const { data: work, error: e2 } = await db.from('vault_items')
    .update({ reminded_at: nowIso })
    .is('reminded_at', null).is('deleted_at', null)
    .lte('remind_at', nowIso).gt('remind_at', since)
    .select('id, user_id');
  if (e2) return Response.json({ error: e2.message }, { status: 500 });

  const users = new Set([...tasks.map((t) => t.user_id), ...work.map((w) => w.user_id)]);
  if (!users.size) return Response.json({ tasks: 0, work: 0, expired_grants: expired?.length ?? 0 });

  const ids = [...users];
  const [{ data: settings }, { data: subs }] = await Promise.all([
    db.from('user_settings').select('user_id, push_reminders, email_reminders').in('user_id', ids),
    db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', ids),
  ]);

  let pushes = 0, emails = 0;
  const gone: string[] = [];
  for (const uid of ids) {
    const pref = settings?.find((s) => s.user_id === uid) ?? { push_reminders: true, email_reminders: true };
    const mine = tasks.filter((t) => t.user_id === uid);
    const myWork = work.filter((w) => w.user_id === uid).length;
    const when = (t: (typeof mine)[number]) => (t.due_time ? `${t.due_date} ${t.due_time}` : t.due_date ?? '');

    if (pref.push_reminders && VAPID && CONTACT) {
      const msgs: Push[] = mine.length <= 3
        ? mine.map((t) => ({ title: t.title.slice(0, 120), body: t.due_time ? `Due at ${t.due_time}` : 'Due today', url: './#/today', tag: `task-${t.id}` }))
        : [{ title: `${mine.length} tasks are due`, body: mine.slice(0, 3).map((t) => t.title).join(' · ').slice(0, 200), url: './#/today', tag: 'tasks' }];
      if (myWork) msgs.push({ title: myWork === 1 ? 'A work task is due' : `${myWork} work tasks are due`, body: 'Unlock the Work section to see it.', url: './#/work', tag: 'work' });
      for (const sub of (subs ?? []).filter((s) => s.user_id === uid)) {
        for (const m of msgs) {
          const r = await sendPush(sub, m);
          if (r === 'ok') pushes++;
          if (r === 'gone') { gone.push(sub.id); break; }
        }
      }
    }

    if (pref.email_reminders && RESEND_KEY && mine.length) {
      const { data } = await db.auth.admin.getUserById(uid);
      const email = data?.user?.email;
      if (email) { await sendEmail(email, mine.map((t) => ({ title: t.title, when: when(t) }))); emails++; }
    }
  }
  if (gone.length) await db.from('push_subscriptions').delete().in('id', gone);

  return Response.json({ tasks: tasks.length, work: work.length, pushes, emails, removed_subscriptions: gone.length, expired_grants: expired?.length ?? 0 });
}));
