import net from 'net';

/**
 * Lightweight, high-performance in-memory Redis RESP server.
 * Implements standard RESP protocol for PUBLISH, SUBSCRIBE, UNSUBSCRIBE,
 * HINCRBY, HGETALL, HGET, HSET, DEL, PING.
 * Enables zero-dependency multi-instance scaling in Node environments.
 */
export function createEmbeddedRedisServer(port = 6379, host = '127.0.0.1') {
    const channels = new Map(); // Map<channelName, Set<Socket>>
    const hashes = new Map();   // Map<key, Map<field, string|number>>
    const kv = new Map();       // Map<key, any>

    const CRLF = Buffer.from('\r\n');

    function parseResp(buf) {
        const commands = [];
        let i = 0;

        while (i < buf.length) {
            const firstByte = buf[i];
            if (firstByte === 42) { // '*' array
                const endLine = buf.indexOf(CRLF, i);
                if (endLine === -1) break;
                const numArgs = parseInt(buf.subarray(i + 1, endLine).toString('ascii'), 10);
                i = endLine + 2;
                const args = [];
                let valid = true;

                for (let a = 0; a < numArgs; a++) {
                    if (i >= buf.length || buf[i] !== 36) { // '$'
                        valid = false;
                        break;
                    }
                    const endLen = buf.indexOf(CRLF, i);
                    if (endLen === -1) {
                        valid = false;
                        break;
                    }
                    const len = parseInt(buf.subarray(i + 1, endLen).toString('ascii'), 10);
                    i = endLen + 2;
                    if (len === -1) {
                        args.push(null);
                        continue;
                    }
                    if (i + len > buf.length) {
                        valid = false;
                        break;
                    }
                    const val = buf.subarray(i, i + len).toString('utf8');
                    args.push(val);
                    i += len + 2; // skip \r\n
                }
                if (valid) {
                    commands.push(args);
                }
            } else if (firstByte === 43) { // '+' inline
                const endLine = buf.indexOf(CRLF, i);
                if (endLine === -1) break;
                commands.push([buf.subarray(i + 1, endLine).toString('utf8')]);
                i = endLine + 2;
            } else {
                // Inline string command
                const endLine = buf.indexOf(CRLF, i);
                if (endLine === -1) break;
                const line = buf.subarray(i, endLine).toString('utf8').trim();
                const parts = line.split(/\s+/).filter(Boolean);
                if (parts.length > 0) commands.push(parts);
                i = endLine + 2;
            }
        }
        return commands;
    }

    const server = net.createServer((socket) => {
        socket.subscriptions = new Set();

        socket.on('data', (data) => {
            const commands = parseResp(data);

            for (const args of commands) {
                if (!args || args.length === 0) continue;
                const cmd = args[0].toUpperCase();

                if (cmd === 'PING') {
                    socket.write('+PONG\r\n');
                } else if (cmd === 'HELLO') {
                    socket.write("-ERR unknown command 'HELLO'\r\n");
                } else if (cmd === 'INFO') {
                    const info = '# Server\r\nredis_version:7.0.0\r\nrole:master\r\nconnected_clients:1\r\n';
                    socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
                } else if (cmd === 'CLIENT') {
                    socket.write('+OK\r\n');
                } else if (cmd === 'SUBSCRIBE') {
                    for (let c = 1; c < args.length; c++) {
                        const channel = args[c];
                        if (!channels.has(channel)) {
                            channels.set(channel, new Set());
                        }
                        channels.get(channel).add(socket);
                        socket.subscriptions.add(channel);

                        // RESP Array: ["subscribe", channel, subscriptionCount]
                        socket.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n:${socket.subscriptions.size}\r\n`);
                    }
                } else if (cmd === 'UNSUBSCRIBE') {
                    for (let c = 1; c < args.length; c++) {
                        const channel = args[c];
                        if (channels.has(channel)) {
                            channels.get(channel).delete(socket);
                        }
                        socket.subscriptions.delete(channel);
                        socket.write(`*3\r\n$11\r\nunsubscribe\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n:${socket.subscriptions.size}\r\n`);
                    }
                } else if (cmd === 'PUBLISH') {
                    const channel = args[1];
                    const message = args[2] || '';
                    const subs = channels.get(channel);
                    let count = 0;

                    if (subs && subs.size > 0) {
                        const msgBuffer = `*3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n$${Buffer.byteLength(message)}\r\n${message}\r\n`;
                        for (const subSocket of subs) {
                            if (!subSocket.destroyed && subSocket.writable) {
                                subSocket.write(msgBuffer);
                                count++;
                            }
                        }
                    }
                    socket.write(`:${count}\r\n`);
                } else if (cmd === 'HINCRBY') {
                    const key = args[1];
                    const field = args[2];
                    const incr = parseInt(args[3] || '1', 10);

                    if (!hashes.has(key)) {
                        hashes.set(key, new Map());
                    }
                    const hashMap = hashes.get(key);
                    const current = parseInt(hashMap.get(field) || '0', 10);
                    const newVal = current + incr;
                    hashMap.set(field, newVal);

                    socket.write(`:${newVal}\r\n`);
                } else if (cmd === 'HGETALL') {
                    const key = args[1];
                    const hashMap = hashes.get(key);

                    if (!hashMap || hashMap.size === 0) {
                        socket.write('*0\r\n');
                    } else {
                        const entries = Array.from(hashMap.entries());
                        let resp = `*${entries.length * 2}\r\n`;
                        for (const [f, v] of entries) {
                            const valStr = String(v);
                            resp += `$${Buffer.byteLength(f)}\r\n${f}\r\n$${Buffer.byteLength(valStr)}\r\n${valStr}\r\n`;
                        }
                        socket.write(resp);
                    }
                } else if (cmd === 'HGET') {
                    const key = args[1];
                    const field = args[2];
                    const hashMap = hashes.get(key);
                    const val = hashMap?.get(field);

                    if (val === undefined || val === null) {
                        socket.write('$-1\r\n');
                    } else {
                        const s = String(val);
                        socket.write(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
                    }
                } else if (cmd === 'HSET') {
                    const key = args[1];
                    if (!hashes.has(key)) hashes.set(key, new Map());
                    const hashMap = hashes.get(key);
                    let added = 0;
                    for (let f = 2; f < args.length; f += 2) {
                        const field = args[f];
                        const val = args[f + 1];
                        if (field && val !== undefined) {
                            if (!hashMap.has(field)) added++;
                            hashMap.set(field, val);
                        }
                    }
                    socket.write(`:${added}\r\n`);
                } else if (cmd === 'DEL') {
                    let deleted = 0;
                    for (let k = 1; k < args.length; k++) {
                        if (hashes.delete(args[k]) || kv.delete(args[k])) deleted++;
                    }
                    socket.write(`:${deleted}\r\n`);
                } else if (cmd === 'COMMAND') {
                    socket.write('*0\r\n');
                } else if (cmd === 'QUIT') {
                    socket.write('+OK\r\n');
                    socket.end();
                } else {
                    // Fallback OK for unsupported setup commands
                    socket.write('+OK\r\n');
                }
            }
        });

        socket.on('close', () => {
            for (const ch of socket.subscriptions) {
                if (channels.has(ch)) {
                    channels.get(ch).delete(socket);
                }
            }
        });

        socket.on('error', () => {
            try { socket.destroy(); } catch {}
        });
    });

    return {
        server,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                resolve({ port, host });
            });
        }),
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}
