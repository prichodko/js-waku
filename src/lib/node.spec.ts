import test from 'ava';
import Libp2p from 'libp2p';
import Pubsub from 'libp2p-interfaces/src/pubsub';

import { NimWaku } from '../test_utils/nim_waku';

import { createNode } from './node';
import { Message } from './waku_message';
import { CODEC, TOPIC, WakuRelay } from './waku_relay';

test('Publishes message', async (t) => {
  const message = Message.fromUtf8String('Bird bird bird, bird is the word!');

  const [node1, node2] = await Promise.all([createNode(), createNode()]);
  const wakuRelayNode1 = new WakuRelay(node1.pubsub);
  const wakuRelayNode2 = new WakuRelay(node2.pubsub);

  // Add node's 2 data to the PeerStore
  node1.peerStore.addressBook.set(node2.peerId, node2.multiaddrs);
  await node1.dial(node2.peerId);

  await wakuRelayNode1.subscribe();
  await new Promise((resolve) =>
    node2.pubsub.once('pubsub:subscription-change', (...args) => resolve(args))
  );

  // Setup the promise before publishing to ensure the event is not missed
  const promise = waitForNextData(node1.pubsub);

  await wakuRelayNode2.publish(message);

  const node1Received = await promise;

  t.true(node1Received.isEqualTo(message));
});

test('Registers waku relay protocol', async (t) => {
  const node = await createNode();

  const protocols = Array.from(node.upgrader.protocols.keys());

  t.truthy(protocols.findIndex((value) => value == CODEC));
});

test('Does not register any sub protocol', async (t) => {
  const node = await createNode();

  const protocols = Array.from(node.upgrader.protocols.keys());
  t.truthy(protocols.findIndex((value) => value.match(/sub/)));
});

test('Nim-interop: nim-waku node connects to js node', async (t) => {
  const node = await createNode();

  const peerId = node.peerId.toB58String();

  const localMultiaddr = node.multiaddrs.find((addr) =>
    addr.toString().match(/127\.0\.0\.1/)
  );
  const multiAddrWithId = localMultiaddr + '/p2p/' + peerId;

  const nimWaku = new NimWaku(t.title);
  await nimWaku.start({ staticnode: multiAddrWithId });

  const nimPeers = await nimWaku.peers();

  t.deepEqual(nimPeers, [
    {
      multiaddr: multiAddrWithId,
      protocol: CODEC,
      connected: true,
    },
  ]);

  const nimPeerId = await nimWaku.getPeerId();
  const jsPeers = node.peerStore.peers;

  t.true(jsPeers.has(nimPeerId.toB58String()));
});

test('Nim-interop: js node receives default subscription from nim node', async (t) => {
  const node = await createNode();

  const peerId = node.peerId.toB58String();

  const localMultiaddr = node.multiaddrs.find((addr) =>
    addr.toString().match(/127\.0\.0\.1/)
  );
  const multiAddrWithId = localMultiaddr + '/p2p/' + peerId;

  const nimWaku = new NimWaku(t.title);
  await nimWaku.start({ staticnode: multiAddrWithId });

  const nimPeerId = await nimWaku.getPeerId();
  const subscribers = node.pubsub.getSubscribers(TOPIC);

  t.true(subscribers.includes(nimPeerId.toB58String()));
});

test('Nim-interop: js node sends message to nim node', async (t) => {
  const message = Message.fromUtf8String('This is a message');
  const node = await createNode();
  const wakuRelayNode = new WakuRelay(node.pubsub);

  // TODO: nim-waku does follow the `StrictNoSign` policy hence we need to change
  // it for nim-waku to process our messages. Can be removed once
  // https://github.com/status-im/nim-waku/issues/422 is fixed
  node.pubsub.globalSignaturePolicy = 'StrictSign';

  const peerId = node.peerId.toB58String();
  const localMultiaddr = node.multiaddrs.find((addr) =>
    addr.toString().match(/127\.0\.0\.1/)
  );
  const multiAddrWithId = localMultiaddr + '/p2p/' + peerId;

  const nimWaku = new NimWaku(t.title);
  await nimWaku.start({ staticnode: multiAddrWithId });

  await patchPeerStore(nimWaku, node);

  await wakuRelayNode.publish(message);

  await nimWaku.waitForLog('WakuMessage received');

  const msgs = await nimWaku.messages();

  t.is(msgs[0].contentTopic, message.contentTopic);
  t.is(msgs[0].version, message.version);

  const payload = Buffer.from(msgs[0].payload);
  t.is(Buffer.compare(payload, message.payload), 0);
});

test('Nim-interop: nim node sends message to js node', async (t) => {
  const message = Message.fromUtf8String('Here is another message.');
  const node = await createNode();
  const wakuRelayNode = new WakuRelay(node.pubsub);

  const peerId = node.peerId.toB58String();
  const localMultiaddr = node.multiaddrs.find((addr) =>
    addr.toString().match(/127\.0\.0\.1/)
  );
  const multiAddrWithId = localMultiaddr + '/p2p/' + peerId;

  const nimWaku = new NimWaku(t.title);
  await nimWaku.start({ staticnode: multiAddrWithId });

  await patchPeerStore(nimWaku, node);

  await wakuRelayNode.subscribe();

  await new Promise((resolve) =>
    node.pubsub.once('gossipsub:heartbeat', resolve)
  );

  const receivedPromise = waitForNextData(node.pubsub);

  await nimWaku.sendMessage(message);

  const receivedMsg = await receivedPromise;

  t.is(receivedMsg.contentTopic, message.contentTopic);
  t.is(receivedMsg.version, message.version);

  const payload = Buffer.from(receivedMsg.payload);
  t.is(Buffer.compare(payload, message.payload), 0);
});

function waitForNextData(pubsub: Pubsub): Promise<Message> {
  return new Promise((resolve) => {
    pubsub.once(TOPIC, resolve);
  }).then((msg: any) => {
    return Message.fromBinary(msg.data);
  });
}

// TODO: Remove this hack, tracked with https://github.com/status-im/nim-waku/issues/419
async function patchPeerStore(nimWaku: NimWaku, node: Libp2p) {
  const nimPeerId = await nimWaku.getPeerId();
  node.identifyService!.peerStore.protoBook.set(nimPeerId, [CODEC]);
  const peer = node.peerStore.peers.get(nimPeerId.toB58String());
  if (!peer) {
    throw 'Did not find nim-waku node in peers';
  }
  peer.protocols = [CODEC];
  node.peerStore.peers.set(nimPeerId.toB58String(), peer);

  await new Promise((resolve) =>
    node.pubsub.once('gossipsub:heartbeat', resolve)
  );
}
