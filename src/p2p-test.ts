// A connection test for peer-to-peer play: can two browsers on different networks reach each other directly, and how fast?
import { joinRoom as viaMqtt } from '@trystero-p2p/mqtt';
import { joinRoom as viaTorrent } from '@trystero-p2p/torrent';
import { joinRoom as viaNostr } from 'trystero';

/** How the two browsers find each other before connecting: public torrent trackers, Nostr relays or MQTT brokers. */
const via = new URLSearchParams(location.search).get('via') ?? 'torrent';
const joinRoom = via === 'nostr' ? viaNostr : via === 'mqtt' ? viaMqtt : viaTorrent;

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => ($('log').textContent += `${new Date().toLocaleTimeString()} ${s}\n`);
const code = $('code') as HTMLInputElement;
code.value = new URLSearchParams(location.search).get('room') ?? Math.random().toString(36).slice(2, 7).toUpperCase();

$('go').addEventListener('click', () => {
  // ?local: two tabs on one machine, where Chrome's hidden (mDNS) local addresses can't reach each other.
  const local = new URLSearchParams(location.search).has('local');
  const room = joinRoom({ appId: 'zombiez-p2p-test', _test_only_mdnsHostFallbackToLoopback: local }, code.value.trim().toUpperCase(), { onJoinError: (e) => log(`Join error: ${e.error}`) });
  $('status').textContent = 'Waiting for the other device…';
  log(`Joined room ${code.value} via ${via}`);
  room.onPeerJoin = (id) => {
    $('status').textContent = 'Connected';
    $('status').className = 'good';
    log(`Peer ${id.slice(0, 6)} connected`);
    const pc = room.getPeers()[id];
    // Unordered, no retransmits: a lost packet is skipped, like UDP. Both sides open the same negotiated channel.
    const fast = pc.createDataChannel('fast', { negotiated: true, id: 77, ordered: false, maxRetransmits: 0 });
    let sent = 0, got = 0;
    const rtts: number[] = [];
    fast.onmessage = (e) => {
      const [kind, seq, t] = JSON.parse(e.data as string) as [string, number, number];
      if (kind === 'ping') fast.send(JSON.stringify(['pong', seq, t]));
      else { got++; rtts.push(performance.now() - t); }
    };
    fast.onopen = () => {
      log('Fast channel open');
      setInterval(() => {
        if (fast.readyState !== 'open') return;
        fast.send(JSON.stringify(['ping', sent++, performance.now()]));
      }, 33);
      setInterval(() => {
        const last = rtts.slice(-90).sort((a, b) => a - b);
        if (!last.length) return;
        const p50 = last[Math.floor(last.length / 2)], p95 = last[Math.floor(last.length * 0.95)];
        const loss = sent ? Math.max(0, 1 - got / sent) * 100 : 0;
        $('fast').textContent = `${p50.toFixed(0)} ms median, ${p95.toFixed(0)} ms p95, ${loss.toFixed(1)}% lost (${sent} sent)`;
      }, 1000);
    };
    setInterval(async () => ($('slow').textContent = `${(await room.ping(id)).toFixed(0)} ms`), 2000);
    setTimeout(() => route(pc), 2000);
  };
  room.onPeerLeave = (id) => {
    $('status').textContent = 'Peer left';
    $('status').className = 'bad';
    log(`Peer ${id.slice(0, 6)} left`);
  };
  history.replaceState(null, '', `?room=${encodeURIComponent(code.value.trim().toUpperCase())}&via=${via}`);
});

/** Direct (host or srflx candidates) or through a relay. */
async function route(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  let pair: RTCIceCandidatePairStats | undefined;
  stats.forEach((s) => { if (s.type === 'candidate-pair' && (s as RTCIceCandidatePairStats).nominated && s.state === 'succeeded') pair = s as RTCIceCandidatePairStats; });
  if (!pair) return void ($('route').textContent = 'Unknown');
  const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
  const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  $('route').textContent = relay ? 'Relayed (needs a TURN server)' : `Direct (${local?.candidateType} to ${remote?.candidateType}, ${local?.protocol ?? 'udp'})`;
  $('route').className = relay ? 'bad' : 'good';
  log(`Route: ${$('route').textContent}`);
}
