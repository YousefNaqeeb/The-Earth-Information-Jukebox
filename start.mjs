import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 8080;
const START_SECONDS = 90;
const IN_CODESPACE = process.env.CODESPACES === "true";
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

if (Number(process.versions.node.split(".")[0]) < 18) {
    console.log(`This needs Node.js 18 or later, and this is ${process.versions.node}. Nothing was started.`);
    process.exit(1);
}

// The Python packages the two NASA services need, as listed in API/requirements.txt.
// Each is imported under the same name it is installed by.
function requiredPackages() {
    try {
        return readFileSync(path.join(ROOT, "API", "requirements.txt"), "utf8").split(/\r?\n/)
            .map(line => (line.split("#")[0].match(/^\s*([A-Za-z0-9_.-]+)/) || [])[1])
            .filter(Boolean);
    } catch {
        return [];
    }
}

// Finds Python and asks it, without starting anything, which of the packages it cannot find.
function findPython(packages) {
    const question = "import importlib.util, json, sys; print(json.dumps({'executable': sys.executable, "
        + "'version': list(sys.version_info[:2]), "
        + "'missing': [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]}))";
    for (const command of process.platform === "win32" ? ["py", "python"] : ["python3", "python"]) {
        try {
            const answer = execFileSync(command, ["-c", question, ...packages], { stdio: ["ignore", "pipe", "ignore"] });
            return { command, ...JSON.parse(answer.toString()) };
        } catch {
            continue;
        }
    }
    return null;
}

const python = findPython(requiredPackages());
const installHint = python ? `${python.command} -m pip install -r API/requirements.txt` : "";

// What stops the two Python services from starting at all, or null when nothing does.
function pythonProblem() {
    if (!python) {
        return "Python was not found. Install Python 3.10 or later and start again.";
    }
    if (python.version[0] < 3 || (python.version[0] === 3 && python.version[1] < 10)) {
        return `it needs Python 3.10 or later, and this is Python ${python.version.join(".")}.`;
    }
    if (python.missing.length) {
        return `${python.missing.length === 1 ? "a Python package is" : "Python packages are"} missing: `
            + `${python.missing.join(", ")}. Install with: ${installHint}`;
    }
    return null;
}

function missingFile(file, hint) {
    return existsSync(path.join(ROOT, file)) ? null : `${file} is missing from this copy of the project. ${hint}`;
}

const outOfDate = "The copy may be out of date, so try: git pull";
const services = [
    { name: "Ocean", port: 8004, address: "/api/ocean", command: process.execPath, args: ["API/server.mjs", "8004"],
      problem: missingFile("API/server.mjs", outOfDate)
          || missingFile("assets/data/OCEAN/index.json", "The ocean data did not come down with the project.") },
    { name: "Night lights", port: 8001, address: "/api/city-lights", command: python?.executable, args: ["API/city_lights_api.py", "8001"],
      problem: missingFile("API/city_lights_api.py", outOfDate) || pythonProblem() },
    { name: "Lightning", port: 8002, address: "/api/lightning", command: python?.executable, args: ["API/lightning_api.py", "8002"],
      problem: missingFile("API/lightning_api.py", outOfDate) || pythonProblem() },
    { name: "Air pollution", port: 8003, address: "/api/pollution", command: process.execPath, args: ["API/pollution_api.mjs", "8003"],
      problem: missingFile("API/pollution_api.mjs", outOfDate) }
];

const started = [];
let stopping = false;

async function answers(service) {
    try {
        return (await fetch(`http://127.0.0.1:${service.port}${service.address}/ready`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
        return false;
    }
}

// Turns the last things a service printed before it stopped into a plain reason.
function reasonItStopped(service, code, lines) {
    const text = lines.join("\n");
    const noPackage = text.match(/No module named '([^']+)'/);
    if (noPackage) {
        return `the Python package ${noPackage[1]} is missing. Install with: ${installHint}`;
    }
    const noFile = text.match(/Cannot find (?:module|package) '([^']+)'/);
    if (noFile) {
        return `a file it needs is missing: ${noFile[1]}. ${outOfDate}`;
    }
    if (/EADDRINUSE|already in use|10048|only one usage of each socket/i.test(text)) {
        return `port ${service.port} is already in use by another program. Close that program and start again.`;
    }
    return `it stopped with code ${code}.` + (lines.length ? ` The last thing it said was: ${lines.at(-1)}` : "");
}

// Starts one service and waits until it answers. Returns true when it is ready.
// When it is not, the reason is logged and kept in service.problem.
async function start(service) {
    if (service.problem) {
        console.log(`${service.name}: NOT started, because ${service.problem}`);
        return false;
    }
    if (await answers(service)) {
        console.log(`${service.name}: already running on port ${service.port}, using it.`);
        return true;
    }
    const began = Date.now();
    const child = spawn(service.command, service.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    started.push(child);
    const lastLines = [];
    let ready = false;
    let exitCode;
    child.on("error", error => {
        exitCode = error.code || "unknown";
    });
    child.on("exit", code => {
        exitCode = code;
        if (ready && !stopping) console.log(`${service.name}: stopped with code ${code}. ${reasonItStopped(service, code, lastLines)}`);
    });
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
        stream.setEncoding("utf8");
        stream.on("data", text => {
            for (const line of text.split(/\r?\n/)) {
                const message = line.replace("Press Ctrl+C to stop.", "").trim();
                if (!message) continue;
                lastLines.push(message);
                if (lastLines.length > 30) lastLines.shift();
                // While a service is starting, its error output is kept for the reason and not
                // shown line by line, since a Python error runs to a dozen lines.
                if (!isError || ready) console.log(`  ${service.name} says: ${message}`);
            }
        });
    }
    while (exitCode === undefined && Date.now() - began < START_SECONDS * 1000) {
        if (await answers(service)) {
            ready = true;
            console.log(`${service.name}: ready on port ${service.port}.`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    service.problem = exitCode === undefined
        ? `it did not answer within ${START_SECONDS} seconds.`
        : reasonItStopped(service, exitCode, lastLines);
    console.log(`${service.name}: NOT started, because ${service.problem}`);
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

function sendJson(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
}

// Hands a data request from the page on to the service it is for, and the answer back.
// A NASA token sent with the request travels on with it, and is not kept or printed here.
async function passOn(service, request, url, response) {
    try {
        const answer = await fetch(`http://127.0.0.1:${service.port}${url.pathname}${url.search}`, {
            headers: request.headers.authorization ? { Authorization: request.headers.authorization } : {}
        });
        response.writeHead(answer.status, {
            "Content-Type": answer.headers.get("content-type") || "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        response.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
        sendJson(response, 502, { error: `The ${service.name.toLowerCase()} service is not running`
            + (service.problem ? `, because ${service.problem}` : ". Look at what start.mjs printed when it started.") });
    }
}

// Serves the page itself: index.html and the scripts, styles and assets it uses. The API folder
// and hidden files are never served. Data requests under /api are handed on to the services, so
// the page only ever talks to this one address. That is what lets it work in a GitHub Codespace,
// where a browser cannot reach the services' own ports.
const pages = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/through-page") {
            sendJson(response, 200, { throughPage: true });
            return;
        }
        const service = services.find(one => url.pathname.startsWith(one.address + "/"));
        if (service) {
            await passOn(service, request, url, response);
            return;
        }
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
        console.log(`The page could NOT be served, because port ${PAGE_PORT} is already in use by another program. `
            + "Close that program and start again.");
    } else {
        console.log(`The page could NOT be served: ${error.message}`);
    }
    stopEverything();
});

process.on("SIGINT", stopEverything);
process.on("SIGTERM", stopEverything);
process.on("exit", () => {
    for (const child of started) child.kill();
});

// Night lights and lightning use the NASA Earthdata token sent with a request, as typed into the
// page. A request without one uses the NASA_EARTHDATA_TOKEN environment variable, which the two
// services inherit from here and which a GitHub Codespace fills in from the repository secret of
// that name. The token itself is never printed.
const hasToken = Boolean(process.env.NASA_EARTHDATA_TOKEN);
console.log(hasToken
    ? "A NASA token is set in NASA_EARTHDATA_TOKEN, so night lights and lightning work without one typed into the page."
    : "No NASA token is set in NASA_EARTHDATA_TOKEN, so night lights and new lightning days need one typed into the page.");
console.log(hasToken && !pythonProblem()
    ? "Starting the four services. Night lights and lightning take up to half a minute."
    : "Starting the four services.");

const results = await Promise.all(services.map(start));
const running = services.filter((service, i) => results[i]).map(service => service.name);
const stopped = services.filter((service, i) => !results[i]).map(service => service.name);
console.log(`\nRunning: ${running.join(", ") || "none"}.`);
if (stopped.length) {
    console.log(`NOT running: ${stopped.join(", ")}. The reason for each is given above.`);
}

// A Codespace reaches this program from outside, so there it listens on every address.
pages.listen(PAGE_PORT, IN_CODESPACE ? "0.0.0.0" : "127.0.0.1", () => {
    const codespaceAddress = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
        ? `https://${process.env.CODESPACE_NAME}-${PAGE_PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/`
        : null;
    console.log(`Open ${IN_CODESPACE && codespaceAddress ? codespaceAddress : `http://127.0.0.1:${PAGE_PORT}/`} in a browser.`);
    console.log("Press Ctrl+C to stop everything.");
});
