// Routing ids: the public address of a PC at the relay. Pure format checks live here (no crypto,
// so the phone can use them); deriving an id from a relay key is in node.js.
export const ROUTING_ID_RE = /^[a-z2-7]{32}$/;

/** @param {unknown} s */
export const isRoutingId = (s) => typeof s === 'string' && ROUTING_ID_RE.test(s);
