import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 8080;
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
};

function findPython() {
    for (const command of process.platform === "win32" ? ["py", "python"] : ["python3", "python"]) {
        try {
            return execFileSync(command, ["-c", "import sys; print(sys.executable)"], { stdio: ["ignore", "pipe", "ignore"] })
                .toString().trim();
        } catch {
            continue;
        }
    }
    return null;
}

const services = [
    { name: "Ocean", port: 8000, command: process.execPath, args: ["API/server.mjs", "8000"],
      ready: "http://127.0.0.1:8000/api/ocean/ready" },
    { name: "Air pollution", port: 8003, command: process.execPath, args: ["API/pollution_api.mjs", "8003"],
      ready: "http://127.0.0.1:8003/api/pollution/ready" }
];
// Night lights and lightning take their NASA Earthdata token from the EARTHDATA_TOKEN environment
// variable, which they inherit from here. In a GitHub Codespace the repository secret of that name
// fills it in. The token itself is never printed.
console.log(process.env.EARTHDATA_TOKEN
    ? "A NASA token is set in EARTHDATA_TOKEN, so night lights and lightning can fetch from NASA."
    : "No NASA token is set in EARTHDATA_TOKEN, so night lights and new lightning days will be refused.");
const python = findPython();
if (python) {
    services.push(
        { name: "Night lights", port: 8001, command: python, args: ["API/city_lights_api.py", "8001"],
          ready: "http://127.0.0.1:8001/api/city-lights/ready" },
        { name: "Lightning", port: 8002, command: python, args: ["API/lightning_api.py", "8002"],
          ready: "http://127.0.0.1:8002/api/lightning/ready" }
    );
} else {
    console.log("Night lights and lightning were not started, because Python was not found.");
}

const started = [];
let stopping = false;

async function answers(url) {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
        return false;
    }
}

async function start(service) {
    if (await answers(service.ready)) {
        console.log(`${service.name}: already running on port ${service.port}, using it.`);
        return true;
    }
    const began = Date.now();
    const child = spawn(service.command, service.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    started.push(child);
    let exited = false;
    child.on("error", () => {
        exited = true;
    });
    child.on("exit", code => {
        exited = true;
        if (!stopping) console.log(`${service.name}: stopped with code ${code}.`);
    });
    for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", text => {
            for (const line of text.split(/\r?\n/)) {
                const message = line.replace("Press Ctrl+C to stop.", "").trim();
                if (message) console.log(`  ${service.name} says: ${message}`);
            }
        });
    }
    while (!exited && Date.now() - began < 90000) {
        if (await answers(service.ready)) {
            console.log(`${service.name}: ready on port ${service.port}.`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`${service.name}: did NOT become ready.`);
    return false;
}

function stopEverything() {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping the services.");
    for (const child of started) child.kill();
    pages.close();
    setTimeout(() => process.exit(0), 500);
}

// The services only answer data requests, so this serves the page itself: index.html and the
// scripts, styles and assets it uses. The API folder and hidden files are never served.
const pages = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        const name = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
        const file = path.join(ROOT, name);
        const parts = path.relative(ROOT, file).split(path.sep);
        const allowed = !parts.includes("..")
            && !parts.some(part => part.startsWith("."))
            && parts[0].toLowerCase() !== "api"
            && TYPES[path.extname(file).toLowerCase()];
        if (!allowed) throw new Error("not served");
        const body = await readFile(file);
        response.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()], "Cache-Control": "no-store" });
        response.end(body);
    } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    }
});

pages.on("error", error => {
    if (error.code === "EADDRINUSE") {
        console.log(`Port ${PAGE_PORT} is already in use, so the page could not be served. Close whatever is using it and start again.`);
    } else {
        console.log(error.message);
    }
    stopEverything();
});

process.on("SIGINT", stopEverything);
process.on("SIGTERM", stopEverything);
process.on("exit", () => {
    for (const child of started) child.kill();
});

console.log(process.env.EARTHDATA_TOKEN && python
    ? "Starting the services. Night lights and lightning take up to half a minute."
    : "Starting the services.");
await Promise.all(services.map(start));
pages.listen(PAGE_PORT, "127.0.0.1", () => {
    console.log(`\nOpen http://127.0.0.1:${PAGE_PORT}/ in a browser.`);
    console.log("Press Ctrl+C to stop everything.");
});
