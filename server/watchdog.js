//watchdog: держит публичный порт, запускает сервер по требованию, проксирует HTTP и WebSocket
//сам сервер при простое выходит (см. WebWorker.periodicIdleRelease), освобождая всю память
const fs = require('fs-extra');
const http = require('http');
const net = require('net');
const path = require('path');
const {spawn} = require('child_process');

const argv = require('minimist')(process.argv.slice(2), {string: ['host', 'port', 'config', 'data-dir', 'app-dir', 'lib-dir', 'inpx']});

const INTERNAL_HOST = '127.0.0.1';

let config;
let PUBLIC_HOST;
let PUBLIC_PORT;
let INTERNAL_PORT;
let logFile;

let child = null;
let startPromise = null;
let lastFailTime = 0;
let shuttingDown = false;

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (logFile) {
        try {
            fs.appendFileSync(logFile, line + '\n');
        } catch (e) {
            //
        }
    }
    console.log(line);
}

function spawnServer() {
    const args = ['--expose-gc', 'server'];
    for (const key of ['config', 'data-dir', 'app-dir', 'lib-dir', 'inpx']) {
        if (argv[key])
            args.push(`--${key}=${argv[key]}`);
    }
    if (argv.recreate)
        args.push('--recreate');
    if (argv['unsafe-filter'])
        args.push('--unsafe-filter');
    args.push(`--host=${INTERNAL_HOST}`);
    args.push(`--port=${INTERNAL_PORT}`);

    log(`spawning: ${path.basename(process.execPath)} ${args.join(' ')}`);

    child = spawn(process.execPath, args, {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onOutput = (data) => {
        for (const line of data.toString().split(/\r?\n/)) {
            if (line.trim())
                log(`[server] ${line}`);
        }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('exit', (code, signal) => {
        log(`server exited (code=${code}, signal=${signal})`);
        child = null;
    });
}

function waitForReady(timeoutMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tryConnect = () => {
            if (shuttingDown)
                return reject(new Error('shutting down'));

            const sock = net.connect(INTERNAL_PORT, INTERNAL_HOST);
            sock.setTimeout(1000);

            sock.once('connect', () => {
                sock.destroy();
                resolve();
            });

            sock.once('error', () => {
                sock.destroy();
                if (child && child.exitCode !== undefined && child.exitCode !== null)
                    return reject(new Error(`server process exited (code=${child.exitCode})`));
                if (Date.now() - start > timeoutMs)
                    return reject(new Error('server not ready in time'));
                setTimeout(tryConnect, 500);
            });

            sock.once('timeout', () => {
                sock.destroy();
                setTimeout(tryConnect, 500);
            });
        };

        tryConnect();
    });
}

function ensureServer() {
    if (startPromise)
        return startPromise;
    if (child)
        return Promise.resolve();

    startPromise = (async () => {
        const backoff = Math.max(0, lastFailTime + 30*1000 - Date.now());
        if (backoff) {
            log(`waiting ${Math.ceil(backoff/1000)}s before server restart (recent failure)`);
            await new Promise(r => setTimeout(r, backoff));
        }

        spawnServer();
        await waitForReady(5*60*1000);
        log('server ready');
    })().catch(e => {
        lastFailTime = Date.now();
        log(`failed to start server: ${e.message}`);
        if (child) {
            child.kill();
            child = null;
        }
        throw e;
    }).finally(() => {
        startPromise = null;
    });

    return startPromise;
}

function proxyHttp(req, res) {
    ensureServer().then(() => {
        const upReq = http.request({
            host: INTERNAL_HOST,
            port: INTERNAL_PORT,
            method: req.method,
            path: req.url,
            headers: req.headers,
        });

        upReq.on('response', upRes => {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
        });

        upReq.on('error', e => {
            log(`http proxy error: ${e.message}`);
            if (!res.headersSent)
                res.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end('Bad gateway');
        });

        req.on('error', () => upReq.destroy());
        req.pipe(upReq);
    }).catch(e => {
        log(`http ensure error: ${e.message}`);
        if (!res.headersSent)
            res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Internal error');
    });
}

function proxyUpgrade(req, socket, head) {
    ensureServer().then(() => {
        const up = net.connect(INTERNAL_PORT, INTERNAL_HOST);

        up.once('connect', () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                if (req.rawHeaders[i].toLowerCase() === 'host')
                    continue;
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
            }
            lines.push(`Host: ${INTERNAL_HOST}:${INTERNAL_PORT}`);
            lines.push('');
            lines.push('');
            up.write(lines.join('\r\n'));
            if (head.length)
                up.write(head);

            up.pipe(socket);
            socket.pipe(up);
        });

        up.once('error', e => {
            log(`ws proxy error: ${e.message}`);
            socket.destroy();
        });
        socket.once('error', () => up.destroy());
    }).catch(e => {
        log(`ws ensure error: ${e.message}`);
        socket.destroy();
    });
}

function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    log('watchdog shutting down');
    if (child)
        child.kill();
    setTimeout(() => process.exit(0), 2000).unref();
}

async function main() {
    const argvDataDir = argv['data-dir'] || argv['app-dir'];
    const configFile = argv['config'];

    const configManager = new (require('./config'))();//singleton
    await configManager.init(argvDataDir, configFile);
    await configManager.load();
    config = configManager.config;

    config.dataDir = path.resolve(config.dataDir || argvDataDir || `${config.execDir}/.${config.name}`);
    config.logDir = config.logDir || `${config.dataDir}/log`;
    await fs.ensureDir(config.logDir);
    logFile = `${config.logDir}/watchdog.log`;

    if (argv.host)
        config.server.host = argv.host;
    if (argv.port)
        config.server.port = argv.port;

    PUBLIC_HOST = config.server.host;
    PUBLIC_PORT = Number(config.server.port);
    INTERNAL_PORT = PUBLIC_PORT + 1;

    log(`watchdog start: public=${PUBLIC_HOST}:${PUBLIC_PORT}, server=${INTERNAL_HOST}:${INTERNAL_PORT}, branch=${config.branch}`);

    const watchdog = http.createServer(proxyHttp);
    watchdog.on('upgrade', proxyUpgrade);
    watchdog.on('error', e => log(`watchdog error: ${e.message}`));
    watchdog.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
        log(`watchdog listening on ${PUBLIC_HOST}:${PUBLIC_PORT}`);
    });

    ensureServer().catch(e => {
        log(`initial server start failed: ${e.message}`);
    });

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
