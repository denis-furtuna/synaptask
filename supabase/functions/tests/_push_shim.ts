// Test-only entry point: sends https://push.test/... to the local mock push service, then
// starts the real reminders function. Production code is not changed.
const real = globalThis.fetch;
const target = Deno.env.get('TEST_PUSH_TARGET') ?? '';
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (target && url.startsWith('https://push.test/')) return real(target + url.slice('https://push.test'.length), init);
  return real(input, init);
};
await import('../reminders/index.ts');
