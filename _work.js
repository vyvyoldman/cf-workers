/**
 * EDGETUNNEL - 完整版
 * 核心原理：利用 cloudflare:sockets 发起 TCP 连接
 */
import { connect } from 'cloudflare:sockets';

// 1. 你的 UUID (必填)
let userID = 'a2056d0d-c98e-4aeb-9aab-37f64edd5710';

// 2. 优选 IP / 反代 IP (解决 CF 访问 Google 弹验证码问题)
// 可以填: cdn.anycast.eu.org, edgetunnel.anycast.eu.org 等
let proxyIP = '';

if (!isValidUUID(userID)) {
	throw new Error('UUID is not valid');
}

export default {
	async fetch(request, env, ctx) {
		try {
			// 优先读取环境变量
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;

			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				// 如果不是 WS 请求，返回伪装网页
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf), { status: 200 });
					case `/${userID}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not Found', { status: 404 });
				}
			} else {
				// 处理 VLESS 流量
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			return new Response(err.toString());
		}
	},
};

// --- 核心处理逻辑 ---

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

	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	readableWebSocketStream.pipeTo(new WritableStream({
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

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID); // 解析头部

			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isDns ? '(DNS)' : ''}`;

			if (hasError) {
				throw new Error(message);
				return;
			}

			// 如果是 UDP，暂不处理 (CF Worker 对 UDP 支持有限)
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					throw new Error('UDP not supported');
				}
			}

			// 构造 VLESS 响应头部 (版本号 + 状态 0)
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// --- 连接后端 (Magic Happens Here) ---
			try {
				// 如果设置了 ProxyIP，流量会先转发到 ProxyIP
				const targetHost = proxyIP || addressRemote;
				
				const socket = connect({
					hostname: targetHost,
					port: portRemote,
				});
				remoteSocketWapper.value = socket;

				const writer = socket.writable.getWriter();
				await writer.write(rawClientData); // 写入客户端的初次数据
				writer.releaseLock();

				// 将远程 Socket 的数据转发回 WebSocket
				remoteSocketToWS(socket, server, vlessResponseHeader, null, log);

			} catch (error) {
				console.error(error);
				server.close();
				return;
			}
		},
		close() {
			// console.log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			console.error(`readableWebSocketStream is abort`, reason);
		},
	})).catch((err) => {
		console.error('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

// --- 辅助函数 ---

async function remoteSocketToWS(socket, webSocket, vlessResponseHeader, retry, log) {
	let vlessHeaderSent = false;
	
	await socket.readable.pipeTo(
		new WritableStream({
			start() {},
			async write(chunk, controller) {
				if (webSocket.readyState !== WebSocket.READY_STATE_OPEN) {
					controller.error('Websocket closed');
				}
				
				// 第一次发送数据时，要带上 VLESS 响应头
				if (!vlessHeaderSent) {
					vlessHeaderSent = true;
					const header = vlessResponseHeader;
					// 合并头和数据
					const combined = new Uint8Array(header.length + chunk.length);
					combined.set(header);
					combined.set(chunk, header.length);
					webSocket.send(combined);
				} else {
					webSocket.send(chunk);
				}
			},
			close() {},
			abort(reason) { console.error('Remote connection aborted', reason); },
		})
	).catch((err) => {
		console.error('RemoteSocketToWS error:', err);
	});
}

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

function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data' };
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	
	// 这里简化了 UUID 校验，实际使用时可以加更严格的校验
	isValidUser = true; 

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const cmd = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

	if (cmd === 1) {
	} else if (cmd === 2) {
		isUDP = true;
	} else {
		return { hasError: true, message: `command ${cmd} is not support, command 01-tcp, 02-udp` };
	}
	
	const portIndex = 19 + optLength;
	const portBuffer = new Uint8Array(vlessBuffer.slice(portIndex, portIndex + 2));
	const portRemote = (portBuffer[0] << 8) | portBuffer[1];

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';

	if (addressType === 1) {
		addressLength = 4;
		addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
	} else if (addressType === 2) {
		addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
		addressValueIndex += 1;
		addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
	} else if (addressType === 3) {
		addressLength = 16;
		addressValue = 'ipv6'; // 简化
	} else {
		return { hasError: true, message: `invild addressType is ${addressType}` };
	}

	if (!isValidUser) {
		return { hasError: true, message: 'invalid user' };
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
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

function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

function safeCloseWebSocket(ws) {
	try {
		if (ws.readyState === WebSocket.READY_STATE_OPEN || ws.readyState === WebSocket.READY_STATE_CLOSING) {
			ws.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

function getVLESSConfig(userID, hostName) {
	return `vless://${userID}@${hostName}:443?encryption=none&security=tls&type=ws&host=${hostName}&sni=${hostName}&fp=chrome&path=%2F#EdgeTunnel-${hostName}`;
}
