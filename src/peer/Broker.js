import Emitter from 'emitter-component';
import ReconnectingWebSocket from 'reconnectingwebsocket';
import SimplePeer from 'simple-peer/simplepeer.min';
import debugFactory from 'debug/browser';

import { requestify } from '../shared/requestify';
import { Connection } from './Connection';

let debug = debugFactory('hookup:broker');
let debugSocket = debugFactory('hookup:socket');
let debugWebRTC = debugFactory('hookup:webrtc');

const TRICKLE = false;

export default class Broker {
  /**
   * Create a new Broker
   * @param {string} url
   */
  constructor (url) {
    // Turn the broker into an event emitter
    Emitter(this);

    // open a WebSocket
    this.url = url;
    this.socket = new ReconnectingWebSocket(url);

    // requestify the WebSocket
    this.connection = requestify();
    this.connection.send = (message) => {
      debugSocket('send message', message);
      this.socket.send(message);
    };
    this.socket.onmessage = (event) => {
      debugSocket('receive message', event.data);
      this.connection.receive(event.data);
    };

    // handle an incoming request
    this.functions = {
      connect: (message) => this._acceptConnection(message)
    };
    this.connection.on('request', (message) => {
      let fn = this.functions[message.type];
      if (!fn) {
        throw new Error(`Unknown message type "${message.type}"`);
      }
      return fn(message);
    });

    // a promise which resolves when connected
    this.ready = new Promise((resolve, reject) => {
      let connecting = true;
      this.socket.onopen = () => {
        debug(`Connected to broker ${url}`);

        this.emit('open');

        if (connecting) {
          connecting = false;
          resolve();
        }
      };

      this.socket.onclose = () => {
        this.emit('close');
        debug('Disconnected from broker');
      };

      this.socket.onerror = (err) => {
        debug('Error', err);

        if (connecting) {
          connecting = false;
          reject(err);
        }
        else {
          this.emit('error', err);
        }
      };
    });
  }

  /**
   * Connect to a peer
   * @param {string} from
   * @param {string} to
   * @return {Connection}
   */
  initiateConnection (from, to) {
    debug(`initiate connection from ${from} to ${to}`);

    let peer = new SimplePeer({
      initiator: true,
      trickle: TRICKLE,
      config: { // TODO: make customizable
        //iceServers: [ { url: 'stun:23.21.150.121' } ] // default of simple-peer
        iceServers: [
          // https://gist.github.com/yetithefoot/7592580
          //{
          //  urls: ['stun:stun.services.mozilla.com']
          //},
          {
            urls: [
              'stun:stun.l.google.com:19302',
              'stun:stun1.l.google.com:19302',
              'stun:stun2.l.google.com:19302',
              'stun:stun3.l.google.com:19302',
              'stun:stun4.l.google.com:19302'
            ]
          }
        ]
      }
    });

    let ready = new Promise((resolve, reject) => {
      let connecting = true;

      peer.once('error', (err) => {
        if (connecting) {
          connecting = false;
          reject(err);
        }
      });

      peer.on('signal', (data) => {
        debugWebRTC('signal', data);

        if (data.type === 'offer') {
          let message = { type: 'connect', from, to, offer: data };

          this.connection.request(message)
              .then(function (answer) {
                debugWebRTC('answer', answer);
                peer.signal(answer);
              })
              .catch(function (err) {
                if (connecting) {
                  connecting = false;
                  reject(err);
                }
              });
        }
      });

      peer.once('connect', () => {
        debug(`connected with ${to}`);

        if (connecting) {
          connecting = false;
          resolve();
        }
      });
    });

    return new Connection(to, peer, ready);
  }

  /**
   * Accept a connection to an other peer
   * @param {Object} message
   * @return {Promise.<Object, Error>} Resolves with a WebRTC answer
   * @private
   */
  _acceptConnection (message) {
    debug('acceptConnection', message);

    return new Promise((resolve, reject) => {
      let connecting = true;
      let peer = new SimplePeer({
        initiator: false,
        trickle: TRICKLE
      });

      let ready = new Promise((resolveReady, rejectReady) => {
        let done = false;
        peer.once('connect', () => {
          debug('connected to', message.from);
          done = true;
          resolveReady(peer);
        });

        peer.once('error', (err) => {
          if (!done) {
            rejectReady(err)
          }
        });
      });

      peer.on('signal', function (data) {
        debugWebRTC('signal', data);

        // receive the answer
        if (data.type === 'answer') {
          if (connecting) {
            connecting = false;
            resolve(data);
          }
        }
      });

      peer.once('error', reject);

      peer.on('error', function (err) {
        debugWebRTC('Error', err);
        if (connecting) {
          connecting = false;
          reject(err);
        }
      });

      // send the offer
      peer.signal(message.offer);

      this.emit('connection', new Connection(message.from, peer, ready));
    });
  }

  close() {
    this.socket.close();
  }
}
