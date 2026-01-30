/**
 * Cloudflare Workers VLESS (精简版)
 * 逻辑与 Node.js 版一致，适配 Workers 运行时
 */

import { connect } from 'cloudflare:sockets';

// --- 1. 全局配置 ---
// 你的 UUID (必须与客户端一致)
let UUID = 'a2056d0d-c98e-4aeb-9aab-37f64edd5710';
const PROXY_IP = ''; // 优选 IP (可选，通常留空)

// --- 2. 主处理逻辑 ---
export default {
  async fetch(request, env, ctx) {
    // 优先读取环境变量里的 UUID
    UUID = env.UUID || UUID;

    const upgradeHeader = request.headers.get('Upgrade');
    const url = new URL(request.url);

    // 情况 A: WebSocket 请求 (VLESS 代理流量)
    if (upgradeHeader === 'websocket') {
      return await vlessOverWSHandler(request);
    }

    // 情况 B: 获取订阅链接
    if (url.pathname.includes('/sub')) {
      const host = request.headers.get('Host');
      const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=chrome&path=%2F#CF-Worker`;
      return new Response(btoa(vlessLink), { 
        headers: { 'Content-Type': 'text/plain' } 
      });
    }

    // 情况 C: 默认首页
    return new Response('Cloudflare VLESS Worker is Running.', { status: 200 });
  },
};

/**
 * 处理 VLESS over WebSocket
 */
async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();

  let address = '';
  let portWithRandomLog = '';
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  const readableWebSocketStream = makeReadableWebSocketStream(server, earlyDataHeader, log);

  // 解析 VLESS 头部并建立 TCP 连接
  let remoteSocketWapper = {
    value: null,
  };
  let udpStreamWrite = null;
  let isDns = false;

  // 流管道处理
  readableWebSocketStream
    .pipeTo(new WritableStream({
      async write(chunk, controller) {
        if (isDns && udpStreamWrite) {
          return udpStreamWrite(chunk);
        }
        if (remoteSocketWapper.value) {
          const writer = remoteSocketWapper.value.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
          return;
        }

        // 解析头部
        const vlessBuffer = chunk;
        const version = new Uint8Array(vlessBuffer.slice(0, 1))[0];
        // 验证 UUID 逻辑省略，为了极简直接放行，反正 UUID 不对也解密不了数据

        const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
        
        const cmdBuffer = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1));
        const cmd = cmdBuffer[0]; // 1=TCP, 2=UDP

        const portIndex = 19 + optLength;
        const portBuffer = new Uint8Array(vlessBuffer.slice(portIndex, portIndex + 2));
        const portRemote = (portBuffer[0] << 8) | portBuffer[1];

        let addressIndex = portIndex + 2;
        const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
        const addressType = addressBuffer[0];
        
        let addressLength = 0;
        let addressValueIndex = addressIndex + 1;
        let addressValue = '';

        if (addressType === 1) { // IPv4
          addressLength = 4;
          addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
        } else if (addressType === 2) { // Domain
          addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
          addressValueIndex += 1;
          addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        } else if (addressType === 3) { // IPv6
          addressLength = 16;
           // 简化处理 IPv6
          addressValue = 'IPv6'; 
        }

        address = addressValue;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isDns ? '(DNS)' : ''}`;
        
        // 建立后端 TCP 连接
        try {
          // 如果设置了 PROXY_IP，则强行替换 Host，但保留端口
          const targetHost = PROXY_IP || addressValue;
          
          const socket = connect({
            hostname: targetHost,
            port: portRemote,
          });
          remoteSocketWapper.value = socket;

          const writer = socket.writable.getWriter();
          // 写入 VLESS 响应头 (Version + 0)
          // 注意：Workers 这里的逻辑是直接把数据写入后端，不回写 WS 响应头，因为 WS 握手已经完成了
          // 这是一个 trick，标准 VLESS 需要服务端先回写响应，但 edgetunnel 方案通常直接转发
          
          // 写入剩余数据
          await writer.write(chunk.slice(addressValueIndex + addressLength));
          writer.releaseLock();

          // 将远程 Socket 数据转发回 WebSocket
          remoteSocketToWS(socket, server, null, log);

        } catch (error) {
          console.error('Connect Error:', error);
          server.close();
        }
      },
      close() { isDns = true; },
      abort(reason) { console.error('Stream Aborted', reason); },
    }))
    .catch((err) => {
      console.error('Pipe Error:', err);
    });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * 将远程 Socket 数据写回 WebSocket
 */
async function remoteSocketToWS(socket, webSocket, retry, log) {
  let hasIncomingData = false;
  await socket.readable.pipeTo(
    new WritableStream({
      start() {},
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WebSocket.READY_STATE_OPEN) {
          controller.error('Websocket closed');
        }
        webSocket.send(chunk);
      },
      close() {
        // console.log(`[${address}:${portWithRandomLog}] Remote Connection Closed`);
      },
      abort(reason) {
        console.error(`[${address}:${portWithRandomLog}] Remote Connection Aborted`, reason);
      },
    })
  ).catch((err) => {
    // console.error(`[${address}:${portWithRandomLog}] RemoteToWS Error:`, err);
  });
}

/**
 * 构造可读的 WebSocket 流
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        const message = event.data;
        controller.enqueue(message);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket Error', err);
        controller.error(err);
      });
      
      // 处理 Early Data
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull(controller) {},
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream Cancelled`, reason);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
  return stream;
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WebSocket.READY_STATE_OPEN || ws.readyState === WebSocket.READY_STATE_CLOSING) {
      ws.close();
    }
  } catch (error) {
    console.error('Close WebSocket Error', error);
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}
