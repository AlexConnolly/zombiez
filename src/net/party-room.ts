import { joinRoom } from '@trystero-p2p/torrent';
import type { ClientMsg, ServerMsg } from './protocol';
import type { Ctl, Room } from './party';

/** One fast channel per connection: Trystero keeps a connection to a browser across rooms, so leaving and joining again reuses it. */
const channels = new WeakMap<RTCPeerConnection, RTCDataChannel>();

/**
 * A party room over WebRTC. Public WebTorrent trackers introduce the browsers (the room code is the
 * meeting point, and also the key that encrypts the introduction); after that they talk directly.
 */
export function partyRoom(code: string): Room {
  // ?p2plocal: two tabs on one machine, where Chrome's hidden (mDNS) local addresses can't reach each other. Testing only.
  const local = typeof location !== 'undefined' && new URLSearchParams(location.search).has('p2plocal');
  const r = joinRoom({ appId: 'zombiez', password: code, _test_only_mdnsHostFallbackToLoopback: local }, code);
  const ctl = r.makeAction('ctl');
  const fast = new Map<string, RTCDataChannel>();
  let left = false;
  const room: Room = {
    onPeerJoin: () => {}, onPeerLeave: () => {}, onCtl: () => {}, onFast: () => {},
    sendCtl: (m, to) => void ctl.send(m as never, to ? { target: to } : undefined),
    sendFast: (m, to) => { const ch = fast.get(to); if (ch?.readyState === 'open') ch.send(JSON.stringify(m)); },
    leave: () => { left = true; void r.leave(); },
  };
  ctl.onMessage = (m, { peerId }) => room.onCtl(m as unknown as Ctl, peerId);
  r.onPeerJoin = (peer) => {
    const pc = r.getPeers()[peer];
    let ch = channels.get(pc);
    if (!ch || ch.readyState === 'closing' || ch.readyState === 'closed') {
      // Unordered with no retransmits: a lost packet is skipped, like UDP. Both ends open the same negotiated channel.
      ch = pc.createDataChannel('fast', { negotiated: true, id: 77, ordered: false, maxRetransmits: 0 });
      channels.set(pc, ch);
    }
    ch.onmessage = (e) => { if (!left) room.onFast(JSON.parse(String(e.data)) as ServerMsg | ClientMsg, peer); };
    fast.set(peer, ch);
    room.onPeerJoin(peer);
  };
  r.onPeerLeave = (peer) => {
    fast.delete(peer);
    room.onPeerLeave(peer);
  };
  return room;
}
