// Web Push with VAPID (used by the reminders function and by the connector's access requests).
import { buildPushHTTPRequest } from 'npm:@pushforge/builder@^2.0.5';

export type PushMessage = { title: string; body: string; url: string; tag: string };
export type PushTarget = { id: string; endpoint: string; p256dh: string; auth: string };

/** 'gone' means the browser dropped the subscription: delete it. */
export async function sendPush(sub: PushTarget, msg: PushMessage, vapidPrivateJwk: string, contact: string): Promise<'ok' | 'gone' | 'error'> {
  try {
    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: vapidPrivateJwk,
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      message: { payload: msg, adminContact: contact, options: { ttl: 3600, urgency: 'high', topic: msg.tag.slice(0, 32) } },
    });
    const res = await fetch(endpoint, { method: 'POST', headers, body });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) { console.warn('push failed', res.status, await res.text().catch(() => '')); return 'error'; }
    return 'ok';
  } catch (e) {
    console.warn('push error', e);
    return 'error';
  }
}
