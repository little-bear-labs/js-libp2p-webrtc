import type { Connection } from '@libp2p/interface-connection'
import { CreateListenerOptions, DialOptions, Listener, symbol, Transport } from '@libp2p/interface-transport'
import type { ConnectionHandler, TransportManager, Upgrader } from '@libp2p/interface-transport'
import { multiaddr, Multiaddr } from '@multiformats/multiaddr'
import type { IncomingStreamData, Registrar } from '@libp2p/interface-registrar'
import type { PeerId } from '@libp2p/interface-peer-id'
import { WebRTCMultiaddrConnection } from '../maconn.js'
import type { Startable } from '@libp2p/interfaces/startable'
import { WebRTCPeerListener } from './listener.js'
import type { PeerStore } from '@libp2p/interface-peer-store'
import { logger } from '@libp2p/logger'
import { connect, handleIncomingStream } from './handler.js'

const log = logger('libp2p:webrtc:peer')

// TODO(ckousik): This is the wrong protocol name and code. They
// will be changed to /webrtc-direct, /webrtc-direct/0.0.1, and 281
// respectively once https://github.com/multiformats/js-multiaddr/pull/309
// is merged.
export const TRANSPORT = '/p2p-webrtc-direct'
export const PROTOCOL = '/p2p-webrtc-direct/0.0.1'
export const CODE = 276

export interface WebRTCPeerTransportInit {
  rtcConfiguration?: RTCConfiguration
}

export interface WebRTCDirectTransportComponents {
  peerId: PeerId
  registrar: Registrar
  upgrader: Upgrader
  transportManager: TransportManager
  peerStore: PeerStore
}

export class WebRTCDirectTransport implements Transport, Startable {
  private readonly _started = false
  private readonly handler?: ConnectionHandler

  constructor (
    private readonly components: WebRTCDirectTransportComponents,
    private readonly init: WebRTCPeerTransportInit
  ) {
    this._onProtocol = this._onProtocol.bind(this)
  }

  isStarted () {
    return this._started
  }

  async start () {
    await this.components.registrar.handle(PROTOCOL, (data) => {
      this._onProtocol(data).catch(err => log.error('failed to handle incoming connect from %p', data.connection.remotePeer, err))
    })
  }

  async stop () {
    await this.components.registrar.unhandle(PROTOCOL)
  }

  createListener (options: CreateListenerOptions): Listener {
    return new WebRTCPeerListener(this.components)
  }

  get [Symbol.toStringTag] (): string {
    return '@libp2p/webrtc-direct'
  }

  get [symbol] (): true {
    return true
  }

  filter (multiaddrs: Multiaddr[]): Multiaddr[] {
    return multiaddrs.filter((ma) => {
      const codes = ma.protoCodes()
      return codes.includes(CODE)
    })
  }

  /*
   * dial connects to a remote via the circuit relay or any other protocol
   * and proceeds to upgrade to a webrtc connection.
   * multiaddr of the form: <multiaddr>/webrtc-direct/p2p/<destination-peer>
   * For a circuit relay, this will be of the form
   * <relay address>/p2p/<relay-peer>/p2p-circuit/webrtc-direct/p2p/<destination-peer>
  */
  async dial (ma: Multiaddr, options: DialOptions): Promise<Connection> {
    log.trace('dialing address: ', ma)
    const addrs = ma.toString().split(TRANSPORT)
    if (addrs.length !== 2) {
      // TODO(ckousik): Change to errCode
      throw new Error('invalid multiaddr')
    }
    // look for remote peerId
    const remoteAddr = multiaddr(addrs[0])
    const destination = multiaddr(addrs[1])

    const destinationIdString = destination.getPeerId()
    if (destinationIdString == null) {
      // TODO(ckousik): Change to errCode
      throw new Error('bad destination')
    }

    const controller = new AbortController()
    if (options.signal == null) {
      options.signal = controller.signal
    }

    const connection = await this.components.transportManager.dial(remoteAddr)

    const rawStream = await connection.newStream([PROTOCOL], options)

    const [pc, muxerFactory] = await connect({
      stream: rawStream,
      rtcConfiguration: this.init.rtcConfiguration,
      signal: options.signal
    })

    rawStream.close()
    return await options.upgrader.upgradeOutbound(
      new WebRTCMultiaddrConnection({
        peerConnection: pc,
        timeline: { open: (new Date()).getTime() },
        remoteAddr: connection.remoteAddr
      }),
      {
        skipProtection: true,
        skipEncryption: true,
        muxerFactory
      }
    )
  }

  async _onProtocol ({ connection, stream }: IncomingStreamData) {
    const [pc, muxerFactory] = await handleIncomingStream({
      rtcConfiguration: this.init.rtcConfiguration,
      connection,
      stream
    })
    const conn = await this.components.upgrader.upgradeInbound(new WebRTCMultiaddrConnection({
      peerConnection: pc,
      timeline: { open: (new Date()).getTime() },
      remoteAddr: connection.remoteAddr
    }), {
      skipEncryption: true,
      skipProtection: true,
      muxerFactory
    })
    stream.close()
    if (this.handler != null) {
      this.handler(conn)
    }
  }
}
