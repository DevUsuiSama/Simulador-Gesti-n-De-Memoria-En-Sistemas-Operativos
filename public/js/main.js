const config = {
    memorySize: 1024,           // KB totales
    algorithm: "firstFit",      // firstFit | bestFit | worstFit
    speed: 5,                   // ticks por segundo (slider)
    blockSize: 16,              // KB por bloque
    autoGenerate: false,
    processIdCounter: 1,
    processes: [],              // PCB list
    memory: [],                 // array de bloques: 0 (libre) o PID
    logEntries: [],
    quantum: 6,                 // ticks por proceso en RR
    contextSwitchCost: 0,       // ticks de coste de cambio de contexto
    ioProbability: 0.06,        // probabilidad de bloqueo por I/O en un tick
    minIoBlockTicks: 2,
    maxIoBlockTicks: 6,
    clock: { running: false, timerId: null, tick: 0 },
    nextAutoAtTick: null
};

const elements = {
    memorySize: document.getElementById("memorySize"),
    algorithm: document.getElementById("algorithm"),
    processSpeed: document.getElementById("processSpeed"),
    initSimulation: document.getElementById("initSimulation"),
    processSize: document.getElementById("processSize"),
    processDuration: document.getElementById("processDuration"),
    addProcess: document.getElementById("addProcess"),
    autoGenerate: document.getElementById("autoGenerate"),
    memoryMap: document.getElementById("memoryMap"),
    processTableBody: document.getElementById("processTableBody"),
    systemLog: document.getElementById("systemLog"),
    totalMemory: document.getElementById("totalMemory"),
    freeMemory: document.getElementById("freeMemory")
};

// Estructuras de planificación
const scheduler = {
    readyQueue: [],
    running: null,     // PID
    csTicksLeft: 0     // coste de cambio de contexto restante
};

document.addEventListener("DOMContentLoaded", init);

function init() {
    setupEventListeners();
    setupMatrixBackground();
    initializeMemory();
    updateDisplay();
}

function setupEventListeners() {
    elements.initSimulation.addEventListener("click", initializeSimulation);
    elements.addProcess.addEventListener("click", addNewProcess);
    elements.autoGenerate.addEventListener("click", toggleAutoGenerate);
    elements.memorySize.addEventListener("change", updateMemorySize);
    elements.algorithm.addEventListener("change", updateAlgorithm);
    elements.processSpeed.addEventListener("input", updateSpeed);
}

function initializeSimulation() {
    stopClock();
    initializeMemory();
    config.processes = [];
    config.processIdCounter = 1;
    scheduler.readyQueue = [];
    scheduler.running = null;
    scheduler.csTicksLeft = 0;
    config.clock.tick = 0;
    config.nextAutoAtTick = null;
    addLog("Sistema inicializado. Memoria lista para asignar procesos.", "info");
    addLog(`Algoritmo ${getAlgorithmName()} seleccionado para la asignación de memoria.`, "info");
    updateDisplay();
    startClock();
}

// -----------------------------
// Memoria
// -----------------------------
function initializeMemory() {
    config.memorySize = parseInt(elements.memorySize.value);
    const blocks = Math.floor(config.memorySize / config.blockSize);
    config.memory = Array(blocks).fill(0); // 0 = libre, otro = PID
    elements.totalMemory.textContent = config.memorySize;
    updateFreeMemory();
}

function updateFreeMemory() {
    const freeBlocks = config.memory.filter(b => b === 0).length;
    const freeKB = freeBlocks * config.blockSize;
    elements.freeMemory.textContent = freeKB;
}

// Devuelve lista de huecos libres {start, length} en bloques
function getFreeHoles() {
    const holes = [];
    let start = -1, length = 0;
    for (let i = 0; i < config.memory.length; i++) {
        if (config.memory[i] === 0) {
            if (start === -1) start = i;
            length++;
        } else if (length > 0) {
            holes.push({ start, length });
            start = -1; length = 0;
        }
    }
    if (length > 0) holes.push({ start, length });
    return holes;
}

function allocateMemory(sizeKB, pid) {
    const needed = Math.ceil(sizeKB / config.blockSize);
    const hole = selectHole(needed);
    if (!hole) return -1;
    const base = hole.start;
    for (let i = base; i < base + needed; i++) config.memory[i] = pid;
    updateFreeMemory();
    return base;
}

function selectHole(needed) {
    const holes = getFreeHoles().filter(h => h.length >= needed);
    if (holes.length === 0) return null;
    switch (config.algorithm) {
        case "firstFit":
            return holes[0];
        case "bestFit":
            return holes.reduce((best, h) => (!best || h.length < best.length ? h : best), null);
        case "worstFit":
            return holes.reduce((worst, h) => (!worst || h.length > worst.length ? h : worst), null);
        default:
            return holes[0];
    }
}

function freeMemoryByRange(base, sizeKB) {
    const blocks = Math.ceil(sizeKB / config.blockSize);
    for (let i = base; i < base + blocks && i < config.memory.length; i++) {
        config.memory[i] = 0;
    }
    updateFreeMemory();
}

function compactMemory() {
    // Ordenar procesos vivos por dirección y empaquetar al principio
    const procs = config.processes
        .filter(p => p.state !== "terminated" && p.address !== undefined)
        .sort((a, b) => a.address - b.address);

    let cursor = 0;
    for (const p of procs) {
        const blocks = Math.ceil(p.size / config.blockSize);
        // Si ya está donde debe, saltar
        if (p.address !== cursor) {
            // Limpiar sus bloques actuales
            for (let i = p.address; i < p.address + blocks; i++) {
                if (i >= 0 && i < config.memory.length && config.memory[i] === p.id) {
                    config.memory[i] = 0;
                }
            }
            // Escribir en nueva posición
            for (let i = 0; i < blocks; i++) config.memory[cursor + i] = p.id;
            p.address = cursor;
        }
        cursor += blocks;
    }
    // Rellenar resto con 0
    for (let i = cursor; i < config.memory.length; i++) config.memory[i] = 0;
    updateFreeMemory();
    addLog("Compactación realizada para reducir fragmentación externa.", "info");
}

// -----------------------------
// Procesos y planificación
// -----------------------------
function addNewProcess() {
    const size = parseInt(elements.processSize.value);
    const duration = parseInt(elements.processDuration.value);

    if (size > config.memorySize) {
        addLog(`Error: El proceso requiere ${size}KB pero la memoria total es de ${config.memorySize}KB.`, "error");
        return;
    }

    const pid = config.processIdCounter++;
    const pcb = {
        id: pid,
        size,
        duration,
        remaining: duration,
        progress: 0,
        state: "new",
        address: undefined,
        timeInQuantum: 0,
        blockedUntil: null,
        arrivalTick: config.clock.tick
    };

    // Intentar asignación
    let base = allocateMemory(size, pid);
    if (base === -1) {
        // Intento con compactación
        compactMemory();
        base = allocateMemory(size, pid);
        if (base === -1) {
            addLog(`No hay suficiente memoria contigua para el proceso (${size}KB requeridos).`, "warning");
            return;
        }
    }

    pcb.address = base;
    pcb.state = "ready";
    config.processes.push(pcb);
    scheduler.readyQueue.push(pid);

    addLog(`Proceso ${pid} creado (${size}KB, ${duration} ticks) y asignado en bloque ${base}.`, "success");
    updateDisplay();
}

function createAutoProcess() {
    // Tamaño relativo al total para “realismo”
    const maxKB = Math.max(config.blockSize, Math.floor(config.memorySize * 0.25)); // hasta 25% de la RAM
    const minKB = config.blockSize;
    const size = roundToBlock(randInt(minKB, maxKB));
    // Duración proporcional al tamaño con ruido
    const baseDur = Math.max(5, Math.floor(size / (config.blockSize * 0.5)));
    const duration = clamp(baseDur + randInt(-3, 5), 5, 50);
    // Usamos la misma ruta de alta
    const pidBefore = config.processIdCounter;
    elements.processSize.value = size;
    elements.processDuration.value = duration;
    addNewProcess();
    if (config.processIdCounter === pidBefore) {
        // No se pudo crear tras compactación -> esperar y reintentar
        addLog("Generación automática: postergada por falta de memoria contigua.", "warning");
    }
}

function roundToBlock(kb) {
    const b = config.blockSize;
    return Math.max(b, Math.ceil(kb / b) * b);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

// Obtener PCB por PID
function getPCB(pid) {
    return config.processes.find(p => p.id === pid);
}

function scheduleNext() {
    if (scheduler.running !== null) return; // ya hay en CPU
    while (scheduler.readyQueue.length > 0) {
        const pid = scheduler.readyQueue.shift();
        const p = getPCB(pid);
        if (!p || p.state !== "ready") continue;
        scheduler.running = pid;
        p.state = "running";
        p.timeInQuantum = 0;
        return;
    }
}

function preemptRunning(reason = "quantum") {
    const pid = scheduler.running;
    if (pid === null) return;
    const p = getPCB(pid);
    if (p && p.state === "running") {
        p.state = "ready";
        scheduler.readyQueue.push(pid);
    }
    scheduler.running = null;
    if (config.contextSwitchCost > 0) scheduler.csTicksLeft = config.contextSwitchCost;
    addLog(`Conmutación por ${reason}.`, "info");
}

function terminateProcess(pid) {
    const p = getPCB(pid);
    if (!p) return;
    p.state = "terminated";
    freeMemoryByRange(p.address, p.size);
    p.address = undefined;
    addLog(`Proceso ${pid} terminado. Memoria liberada.`, "success");
    if (scheduler.running === pid) scheduler.running = null;
}

function maybeBlockForIO(p) {
    if (Math.random() < config.ioProbability) {
        const wait = randInt(config.minIoBlockTicks, config.maxIoBlockTicks);
        p.state = "blocked";
        p.blockedUntil = config.clock.tick + wait;
        addLog(`Proceso ${p.id} bloqueado por I/O durante ${wait} ticks.`, "info");
        scheduler.running = null;
        if (config.contextSwitchCost > 0) scheduler.csTicksLeft = config.contextSwitchCost;
        return true;
    }
    return false;
}

function unblockReady() {
    for (const p of config.processes) {
        if (p.state === "blocked" && p.blockedUntil !== null && config.clock.tick >= p.blockedUntil) {
            p.blockedUntil = null;
            p.state = "ready";
            scheduler.readyQueue.push(p.id);
            addLog(`Proceso ${p.id} desbloqueado y listo.`, "info");
        }
    }
}

// -----------------------------
// Reloj y ciclo de simulación
// -----------------------------
function startClock() {
    if (config.clock.running) return;
    config.clock.running = true;
    const interval = Math.max(20, Math.floor(1000 / Math.max(1, config.speed)));
    config.clock.timerId = setInterval(tick, interval);
}

function stopClock() {
    config.clock.running = false;
    if (config.clock.timerId) clearInterval(config.clock.timerId);
    config.clock.timerId = null;
}

function tick() {
    config.clock.tick++;

    // Desbloqueos
    unblockReady();

    // Coste de cambio de contexto
    if (scheduler.csTicksLeft > 0) {
        scheduler.csTicksLeft--;
        if (scheduler.csTicksLeft === 0) scheduleNext();
        updateDisplay();
        return;
    }

    // Planificar si no hay proceso corriendo
    if (scheduler.running === null) scheduleNext();

    // Ejecutar un tick del proceso en CPU
    if (scheduler.running !== null) {
        const p = getPCB(scheduler.running);
        if (!p) {
            scheduler.running = null;
        } else {
            // Consumo de CPU
            p.remaining = Math.max(0, p.remaining - 1);
            p.progress++;
            p.timeInQuantum++;

            // Posible bloqueo I/O (solo si le queda trabajo)
            if (p.remaining > 0) {
                if (maybeBlockForIO(p)) {
                    updateDisplay();
                    return;
                }
            }

            // Terminación
            if (p.remaining <= 0) {
                terminateProcess(p.id);
            } else if (p.timeInQuantum >= config.quantum) {
                preemptRunning("quantum agotado");
            }
        }
    }

    // Generación automática
    if (config.autoGenerate) {
        if (config.nextAutoAtTick === null) {
            config.nextAutoAtTick = config.clock.tick + randInt(3, 8);
        } else if (config.clock.tick >= config.nextAutoAtTick) {
            createAutoProcess();
            // Intervalo se ajusta ligeramente con la velocidad
            const base = Math.max(3, Math.floor(12 - Math.min(10, config.speed)));
            config.nextAutoAtTick = config.clock.tick + randInt(base, base + 8);
        }
    }

    updateDisplay();
}

// -----------------------------
// UI y visualización
// -----------------------------
function addLog(msg, level = "info") {
    const now = new Date();
    const t = `[${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}]`;
    const div = document.createElement("div");
    div.className = "log-entry";
    div.innerHTML = `<span class="log-time">${t}</span> <span class="log-${level}">${msg}</span>`;
    elements.systemLog.appendChild(div);
    elements.systemLog.scrollTop = elements.systemLog.scrollHeight;
    if (elements.systemLog.children.length > 200) {
        elements.systemLog.removeChild(elements.systemLog.children[0]);
    }
}

function updateDisplay() {
    updateMemoryVisualization();
    updateProcessTable();
}

function updateMemoryVisualization() {
    elements.memoryMap.innerHTML = "";
    const blockCount = config.memory.length || 1;
    const w = Math.max(20, Math.min(40, Math.floor(1000 / blockCount)));
    config.memory.forEach((pid, idx) => {
        const div = document.createElement("div");
        const allocated = pid !== 0;
        div.className = "memory-block " + (allocated ? "allocated" : "free");
        div.style.width = `${w}px`;
        div.title = `Bloque ${idx} - ${allocated ? "Ocupado (PID " + pid + ")" : "Libre"}`;
        // Color estable por PID
        if (allocated) {
            const hue = (pid * 47) % 360;
            div.style.backgroundColor = `hsl(${hue} 70% 45% / 0.85)`;
            div.style.color = "#fff";
            div.textContent = idx; // índice para depuración visual
        } else {
            div.textContent = idx;
        }
        elements.memoryMap.appendChild(div);
    });
    updateFreeMemory();
}

function updateProcessTable() {
    elements.processTableBody.innerHTML = "";
    config.processes.forEach(p => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${p.id}</td>
            <td>${p.size}</td>
            <td class="state-${p.state}">${getStateName(p.state)}</td>
            <td>${p.address !== undefined ? p.address : "N/A"}</td>
            <td>${p.progress}/${p.duration}</td>
        `;
        elements.processTableBody.appendChild(tr);
    });

    // Auto-scroll al final
    const scrollContainer = document.querySelector(".table-scroll");
    if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
}

function getAlgorithmName() {
    switch (config.algorithm) {
        case "firstFit": default: return "First Fit";
        case "bestFit": return "Best Fit";
        case "worstFit": return "Worst Fit";
    }
}

function getStateName(s) {
    switch (s) {
        case "new": return "Nuevo";
        case "ready": return "Listo";
        case "running": return "Ejecutando";
        case "blocked": return "Bloqueado";
        case "terminated": return "Terminado";
        default: return s;
    }
}

function updateMemorySize() {
    config.memorySize = parseInt(elements.memorySize.value);
    initializeMemory();
    addLog(`Tamaño de memoria cambiado a ${config.memorySize}KB.`, "info");
    updateDisplay();
}

function updateAlgorithm() {
    config.algorithm = elements.algorithm.value;
    addLog(`Algoritmo cambiado a ${getAlgorithmName()}.`, "info");
}

function updateSpeed() {
    const old = config.speed;
    config.speed = Math.max(1, parseInt(elements.processSpeed.value));
    if (config.clock.running && config.speed !== old) {
        stopClock();
        startClock();
    }
}

function toggleAutoGenerate() {
    config.autoGenerate = !config.autoGenerate;
    elements.autoGenerate.textContent = config.autoGenerate
        ? "DESACTIVAR AUTO-PROCESOS"
        : "ACTIVAR AUTO-PROCESOS";
    if (config.autoGenerate) {
        config.nextAutoAtTick = null;
        addLog("Generación automática de procesos activada.", "info");
    } else {
        addLog("Generación automática de procesos desactivada.", "info");
    }
}

// Fondo “matrix” como estaba
function setupMatrixBackground() {
    const canvas = document.getElementById("matrix-bg");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const chars = "01010101abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#$%&/*+=?¡¿!";
    const columns = canvas.width / 12;
    const drops = [];
    for (let i = 0; i < columns; i++) drops[i] = 1;

    setInterval(function () {
        ctx.fillStyle = "rgba(10, 10, 26, 0.05)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = config.autoGenerate ? "var(--hacker-green)" : "var(--hacker-blue)";
        ctx.font = "12px monospace";
        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * 12, drops[i] * 12);
            if (drops[i] * 12 > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
        }
    }, 33);

    window.addEventListener("resize", () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    });
}

