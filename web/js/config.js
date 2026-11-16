// Public configuration. These values are safe to commit: the publishable key only works
// together with the Row Level Security rules in the database, and the two public keys
// come from tools/keys.html (their private halves are Edge Function secrets).
// Leave supabaseUrl / supabaseKey empty to run in LOCAL MODE (data stays in this browser only).
export const CONFIG = {
  supabaseUrl: 'https://mcixodikgxqggzqcvmmh.supabase.co',
  supabaseKey: 'sb_publishable_-kDsw8lHQYFBBZ0H_kklag_SprESzNt', // the "publishable" key, never the secret key
  vapidPublicKey: 'BM0O1dqJ4s-crSxGrVydcNEYbJavy5v59yX_lnBm__YmBXIrD3TDeu7TxTYReo2jRPXz9OOKDvqdRqToyyg9uo8', // push notifications
  // lets you give Claude time-limited access to the Work section
  grantPublicKey: { kty: 'RSA', e: 'AQAB', n: '2Up4JwmSCIAdzlmHmWmtasnAIpuNamsdxtrdeAhd21rdJjV6M9SFwLqy7EVoOV1xov022BmqsDWogonnXy3vot15xwQxSZr1K4OHqlLReghbhyl47SNzvZIPG2PsUW9Lo41L9LAeEOfvka3V-5fVo30riuHFxYMv8wU5bK69v6SdphstbyyMI-FNyRnIY-spgrgm2RXDsuhXoyGQFupbUhgK8Ue7oDqNQEcNNY2MYEm2Lz447KPd3ph1RrB2ugbLljDIcNQ_qPI4GmQ0Xm7mnQGViuwjlivh8lgcVDszAOVdqf4lua8Q--NS5Zhecm94wIxctjsvzPdIkwwTwCWUrD8MIim3zlWnIBbz275-xqkY4epvxsW7o7WwJTx5mW9V-asPfu9h5vTDequHVYTsQgHAtI0iyZesIkZF1MvaPsEhCej8cG47C5ntSg0LFzMtNW4lA13vkvvf2CLWwjPvU38V1uVHjJ6i0n3_AK3UfcHfB1mxSI6fTaQ40mtirObj' },
};
