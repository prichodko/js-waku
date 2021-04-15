import Libp2p from 'libp2p';
import Mplex from 'libp2p-mplex';
import { bytes } from 'libp2p-noise/dist/src/@types/basic';
import { Noise } from 'libp2p-noise/dist/src/noise';
import Websockets from 'libp2p-websockets';
import Multiaddr from 'multiaddr';
import PeerId from 'peer-id';

import { RelayCodec, WakuRelay, WakuRelayPubsub } from './waku_relay';
import { StoreCodec, WakuStore } from './waku_store';

export interface CreateOptions {
  listenAddresses: string[];
  staticNoiseKey: bytes | undefined;
  modules: {
    transport: import('libp2p-interfaces/src/transport/types').TransportFactory<
      any,
      any
    >[];
  };
}

export default class Waku {
  private constructor(
    public libp2p: Libp2p,
    public relay: WakuRelay,
    public store: WakuStore
  ) {}

  /**
   * Create new waku node
   * @param listenAddresses: Array of Multiaddrs on which the node should listen.
   * If not present, the node is dial only.
   * @param staticNoiseKey: A static key to use for noise,
   * mainly used for test to reduce entropy usage.
   * @throws If
   * @returns {Promise<Waku>}
   */
  static async create(options: Partial<CreateOptions>): Promise<Waku> {
    const opts = Object.assign(
      {
        listenAddresses: [],
        staticNoiseKey: undefined,
      },
      options
    );

    let transport = [Websockets];
    if (opts.modules?.transport) {
      transport = transport.concat(opts.modules?.transport);
    }

    // FIXME: By controlling the creation of libp2p we have to think about what
    // needs to be exposed and what does not. Ideally, we should be able to let
    // the user create the WakuStore, WakuRelay instances and pass them when
    // creating the libp2p instance.
    const libp2p = await Libp2p.create({
      addresses: {
        listen: opts.listenAddresses,
      },
      modules: {
        transport,
        streamMuxer: [Mplex],
        connEncryption: [new Noise(opts.staticNoiseKey)],
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: Type needs update
        pubsub: WakuRelayPubsub,
      },
    });

    const wakuStore = new WakuStore(libp2p);

    await libp2p.start();

    return new Waku(libp2p, new WakuRelay(libp2p.pubsub), wakuStore);
  }

  /**
   * Dials to the provided peer.
   * @param peer The peer to dial
   */
  async dial(peer: PeerId | Multiaddr | string) {
    await this.libp2p.dialProtocol(peer, [RelayCodec, StoreCodec]);
  }

  async dialWithMultiAddr(peerId: PeerId, multiaddr: Multiaddr[]) {
    this.libp2p.peerStore.addressBook.set(peerId, multiaddr);
  }

  async stop() {
    await this.libp2p.stop();
  }

  /**
   * Return the local multiaddr with peer id on which libp2p is listening.
   * @throws if libp2p is not listening on localhost
   */
  getLocalMultiaddrWithID(): string {
    const localMultiaddr = this.libp2p.multiaddrs.find((addr) =>
      addr.toString().match(/127\.0\.0\.1/)
    );
    if (!localMultiaddr || localMultiaddr.toString() === '') {
      throw 'Not listening on localhost';
    }
    const multiAddrWithId =
      localMultiaddr + '/p2p/' + this.libp2p.peerId.toB58String();
    return multiAddrWithId;
  }
}
