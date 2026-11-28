import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { Voz } from "./rpc.js"

/**
 * Lee en voz alta las respuestas del asistente.
 *
 * Motor:
 *   - edge  -> edge-tts (voces neuronales de Microsoft, requiere internet)
 *   - say   -> voz de macOS (offline)
 *   - auto  -> edge si está instalado, si no say  (por defecto)
 *
 * Variables:
 *   OPENCODE_TTS_ENGINE=edge|say|auto
 *   OPENCODE_TTS_VOICE=es-MX-DaliaNeural      (voz de edge)
 *   OPENCODE_TTS_RATE=+10%                    (velocidad de edge)
 *   OPENCODE_TTS_SAY_VOICE=Mónica             (voz de respaldo)
 *   OPENCODE_TTS_RATE_SAY=190                 (ppm de say)
 */

const MAX_CHARS = 6000
const INTERVALO_TRABAJANDO_MS = 30_000
const RETRASO_PRIMER_TRABAJANDO_MS = 3_000
const PAUSA_ENTRE_AVISOS_MS = 3_000
const TMP_PREFIX = "opencode-tts-"
const DIR_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets")
const SONIDO_INICIO_DICTADO = join(DIR_ASSETS, "beep.wav")
const SONIDO_FIN_LECTURA = join(DIR_ASSETS, "staplebops-02.aac")
const SONIDO_ENVIO = join(DIR_ASSETS, "staplebops-02.aac")
const SONIDO_FIN_GRABACION = join(DIR_ASSETS, "staplebops-01.aac")
const SONIDO_SIN_VOZ = join(DIR_ASSETS, "beep-error.wav")
const SONIDO_CORTE_TRAMO = join(DIR_ASSETS, "beep-tramo.wav")
const DIR_AUDIO_DICTADO = join(process.env.HOME ?? tmpdir(), ".local/share/opencode/log/voz-audio")
const MAX_AUDIOS_DICTADO = 30
type GeneroVoz = "fem" | "masc"
type MotorStt = "auto" | "elevenlabs" | "groq"
type ModoConcurrencia = "cortar" | "esperar"

const ARCHIVO_ESTADO_ECO = join(tmpdir(), "opencode-tts-eco-estado.json")
const ARCHIVO_ESTADO_HABLANDO = join(tmpdir(), "opencode-tts-hablando-estado.json")
const ARCHIVO_TURNO_VOZ = join(tmpdir(), "opencode-tts-turno-voz.json")
const ARCHIVO_ESTADO_TRABAJANDO = join(tmpdir(), "opencode-tts-trabajando-estado.json")
const ARCHIVO_ESTADO_GENERO = join(tmpdir(), "opencode-tts-genero-estado.json")
const ARCHIVO_ESTADO_MOTOR = join(tmpdir(), "opencode-tts-motor-estado.json")
const ARCHIVO_ESTADO_MOTOR_VOZ = join(tmpdir(), "opencode-tts-motor-voz-estado.json")
const ARCHIVO_ESTADO_SESIONES_APAGADAS = join(tmpdir(), "opencode-tts-sesiones-apagadas.json")
const ARCHIVO_ESTADO_ECO_ACTIVO = join(tmpdir(), "opencode-tts-eco-activo-estado.json")
const ARCHIVO_ESTADO_CONCURRENCIA = join(tmpdir(), "opencode-tts-concurrencia-estado.json")
const ARCHIVO_ESTADO_DICTADO = join(tmpdir(), "opencode-tts-dictado-estado.json")
const ARCHIVO_ESTADO_DICTANDO = join(tmpdir(), "opencode-tts-dictando-estado.json")
const LOCK_TRABAJANDO = join(tmpdir(), "opencode-tts-trabajando.lock")
const COOLDOWN_TRABAJANDO_MS = 8_000
const INSTANCIA_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`

function guardarEstadoGenero(genero: GeneroVoz) {
  try {
    writeFileSync(ARCHIVO_ESTADO_GENERO, JSON.stringify({ genero, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerEstadoGenero(): GeneroVoz | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_GENERO)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_GENERO, "utf8")) as { genero?: string }
    return data.genero === "masc" ? "masc" : data.genero === "fem" ? "fem" : undefined
  } catch {
    return undefined
  }
}

function guardarEstadoMotor(motor: MotorStt) {
  try {
    writeFileSync(ARCHIVO_ESTADO_MOTOR, JSON.stringify({ motor, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerEstadoMotor(): MotorStt | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_MOTOR)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_MOTOR, "utf8")) as { motor?: string }
    return data.motor === "elevenlabs" || data.motor === "groq" || data.motor === "auto" ? data.motor : undefined
  } catch {
    return undefined
  }
}

function guardarEstadoMotorVoz(motor: "edge" | "say") {
  try {
    writeFileSync(ARCHIVO_ESTADO_MOTOR_VOZ, JSON.stringify({ motor, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerEstadoMotorVoz(): "edge" | "say" | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_MOTOR_VOZ)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_MOTOR_VOZ, "utf8")) as { motor?: string }
    return data.motor === "edge" || data.motor === "say" ? data.motor : undefined
  } catch {
    return undefined
  }
}

function guardarSesionesApagadas(sesiones: Set<string>) {
  try {
    writeFileSync(ARCHIVO_ESTADO_SESIONES_APAGADAS, JSON.stringify({ ids: Array.from(sesiones), ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerSesionesApagadas(): Set<string> | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_SESIONES_APAGADAS)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_SESIONES_APAGADAS, "utf8")) as { ids?: unknown }
    if (!Array.isArray(data.ids)) return undefined
    return new Set(data.ids.filter((id): id is string => typeof id === "string"))
  } catch {
    return undefined
  }
}

function guardarEstadoEcoActivo(activo: boolean) {
  try {
    writeFileSync(ARCHIVO_ESTADO_ECO_ACTIVO, JSON.stringify({ activo, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerEstadoEcoActivo(): boolean | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_ECO_ACTIVO)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_ECO_ACTIVO, "utf8")) as { activo?: unknown }
    return typeof data.activo === "boolean" ? data.activo : undefined
  } catch {
    return undefined
  }
}

function guardarEstadoConcurrencia(modo: ModoConcurrencia) {
  try {
    writeFileSync(ARCHIVO_ESTADO_CONCURRENCIA, JSON.stringify({ modo, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function leerEstadoConcurrencia(): ModoConcurrencia | undefined {
  try {
    if (!existsSync(ARCHIVO_ESTADO_CONCURRENCIA)) return undefined
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_CONCURRENCIA, "utf8")) as { modo?: string }
    return data.modo === "esperar" ? "esperar" : data.modo === "cortar" ? "cortar" : undefined
  } catch {
    return undefined
  }
}

function guardarEstadoDictado(hasta: number) {
  try {
    writeFileSync(ARCHIVO_ESTADO_DICTADO, JSON.stringify({ hasta }))
  } catch {
    // ignora
  }
}

function leerEstadoDictadoHasta(): number {
  try {
    if (!existsSync(ARCHIVO_ESTADO_DICTADO)) return 0
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_DICTADO, "utf8")) as { hasta?: number }
    return typeof data.hasta === "number" ? data.hasta : 0
  } catch {
    return 0
  }
}

function guardarEstadoDictando(activo: boolean) {
  try {
    writeFileSync(ARCHIVO_ESTADO_DICTANDO, JSON.stringify({ activo, ts: Date.now() }))
  } catch {
    // ignora
  }
}

function dictandoEnCurso(): boolean {
  try {
    if (!existsSync(ARCHIVO_ESTADO_DICTANDO)) return false
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_DICTANDO, "utf8")) as {
      activo?: boolean
      ts?: number
    }
    return data.activo === true && typeof data.ts === "number" && Date.now() - data.ts < 300_000
  } catch {
    return false
  }
}

type EstadoHablandoInfo = {
  activo: boolean
  owner: string
  sessionID: string
  ctrl: string
  turno: string
  ts: number
}

function guardarEstadoHablando(
  activo: boolean,
  opts?: { forzar?: boolean; sessionID?: string; ctrl?: string; turno?: string },
) {
  try {
    if (!activo && !opts?.forzar && existsSync(ARCHIVO_ESTADO_HABLANDO)) {
      const actual = JSON.parse(readFileSync(ARCHIVO_ESTADO_HABLANDO, "utf8")) as { owner?: string }
      if (actual.owner && actual.owner !== INSTANCIA_ID) return
    }
    writeFileSync(
      ARCHIVO_ESTADO_HABLANDO,
      JSON.stringify({
        activo,
        owner: activo ? INSTANCIA_ID : "",
        sessionID: activo ? (opts?.sessionID ?? "") : "",
        ctrl: activo ? (opts?.ctrl ?? "") : "",
        turno: activo ? (opts?.turno ?? "") : "",
        ts: Date.now(),
      }),
    )
  } catch {
    // ignora
  }
}

function leerEstadoHablandoInfo(): EstadoHablandoInfo {
  try {
    if (!existsSync(ARCHIVO_ESTADO_HABLANDO)) {
      return { activo: false, owner: "", sessionID: "", ctrl: "", turno: "", ts: 0 }
    }
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_HABLANDO, "utf8")) as Partial<EstadoHablandoInfo>
    const ts = typeof data.ts === "number" ? data.ts : 0
    const activo = data.activo === true && Date.now() - ts < 90_000
    return {
      activo,
      owner: typeof data.owner === "string" ? data.owner : "",
      sessionID: typeof data.sessionID === "string" ? data.sessionID : "",
      ctrl: typeof data.ctrl === "string" ? data.ctrl : "",
      turno: typeof data.turno === "string" ? data.turno : "",
      ts,
    }
  } catch {
    return { activo: false, owner: "", sessionID: "", ctrl: "", turno: "", ts: 0 }
  }
}

function leerEstadoHablando(): boolean {
  return leerEstadoHablandoInfo().activo
}

function otroHablando(): boolean {
  const info = leerEstadoHablandoInfo()
  return info.activo && Boolean(info.owner) && info.owner !== INSTANCIA_ID
}

function reclamarTurnoVoz(sessionID?: string): string {
  const turno = `${Date.now()}-${INSTANCIA_ID}-${Math.random().toString(36).slice(2)}`
  try {
    writeFileSync(
      ARCHIVO_TURNO_VOZ,
      JSON.stringify({ turno, owner: INSTANCIA_ID, sessionID: sessionID ?? "", ts: Date.now() }),
    )
  } catch {
    // ignora
  }
  return turno
}

function perdioTurnoVoz(turno: string | undefined): boolean {
  if (!turno) return false
  try {
    if (!existsSync(ARCHIVO_TURNO_VOZ)) return false
    const data = JSON.parse(readFileSync(ARCHIVO_TURNO_VOZ, "utf8")) as { turno?: string }
    return Boolean(data.turno && data.turno !== turno)
  } catch {
    return false
  }
}

function cortarAudioGlobal(soloSessionID?: string) {
  const info = leerEstadoHablandoInfo()
  if (!info.activo) return
  if (soloSessionID && info.sessionID !== soloSessionID) return
  if (info.ctrl) {
    try {
      writeFileSync(info.ctrl, "stop")
    } catch {
      // ignora
    }
  }
  if (!soloSessionID && info.owner && info.owner !== INSTANCIA_ID) {
    reclamarTurnoVoz()
  }
}

function limpiarEstadoTrabajando() {
  try {
    writeFileSync(ARCHIVO_ESTADO_TRABAJANDO, JSON.stringify({ ts: 0 }))
  } catch {
    // ignora
  }
}

function reclamarTurnoTrabajando(): boolean {
  const ahora = Date.now()
  try {
    if (existsSync(LOCK_TRABAJANDO)) {
      const edad = ahora - statSync(LOCK_TRABAJANDO).mtimeMs
      if (edad > 2_000) rmSync(LOCK_TRABAJANDO, { force: true })
    }
  } catch {
    // ignora
  }
  try {
    closeSync(openSync(LOCK_TRABAJANDO, "wx"))
  } catch {
    return false
  }
  try {
    if (existsSync(ARCHIVO_ESTADO_TRABAJANDO)) {
      const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_TRABAJANDO, "utf8")) as { ts?: number }
      if (typeof data.ts === "number" && ahora - data.ts < COOLDOWN_TRABAJANDO_MS) {
        return false
      }
    }
    writeFileSync(ARCHIVO_ESTADO_TRABAJANDO, JSON.stringify({ ts: ahora }))
    return true
  } catch {
    return true
  } finally {
    try {
      rmSync(LOCK_TRABAJANDO, { force: true })
    } catch {
      // ignora
    }
  }
}

function guardarEstadoEco(activo: boolean, finEn = 0) {
  try {
    writeFileSync(ARCHIVO_ESTADO_ECO, JSON.stringify({ activo, ts: Date.now(), finEn }))
  } catch {
    // ignora
  }
}

function leerEstadoEco(): { activo: boolean; finEn: number } {
  try {
    if (!existsSync(ARCHIVO_ESTADO_ECO)) return { activo: false, finEn: 0 }
    const data = JSON.parse(readFileSync(ARCHIVO_ESTADO_ECO, "utf8")) as {
      activo?: boolean
      ts?: number
      finEn?: number
    }
    const activo = data.activo === true && typeof data.ts === "number" && Date.now() - data.ts < 45_000
    const finEn = typeof data.finEn === "number" ? data.finEn : 0
    return { activo, finEn }
  } catch {
    return { activo: false, finEn: 0 }
  }
}

function reproducirEfecto(ruta: string) {
  if (!ruta || !existsSync(ruta)) return
  try {
    const child = spawn("afplay", [ruta], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // ignora si afplay no está disponible
  }
}

function reproducirEfectoYEsperar(ruta: string, timeoutMs = 1000): Promise<void> {
  if (!ruta || !existsSync(ruta)) return Promise.resolve()
  return new Promise((resolve) => {
    let listo = false
    const terminar = () => {
      if (listo) return
      listo = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(terminar, timeoutMs)
    try {
      const child = spawn("afplay", [ruta], { stdio: "ignore" })
      child.on("error", terminar)
      child.on("close", terminar)
    } catch {
      terminar()
    }
  })
}

function findEdge(): string | undefined {
  const fromEnv = process.env.OPENCODE_TTS_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const home = process.env.HOME ?? ""
  const candidates = [
    join(home, ".local/bin/edge-tts"),
    "/opt/homebrew/bin/edge-tts",
    "/usr/local/bin/edge-tts",
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate

  const path = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of path) if (existsSync(join(dir, "edge-tts"))) return join(dir, "edge-tts")
  return undefined
}

const EDGE_BIN = findEdge()

/** Busca el intérprete de Python que trae edge-tts leyendo el shebang del binario. */
function findEdgePython(): string | undefined {
  if (!EDGE_BIN) return undefined
  try {
    const firstLine = readFileSync(EDGE_BIN, "utf8").split("\n")[0]?.trim() ?? ""
    if (!firstLine.startsWith("#!")) return undefined
    const target = firstLine.slice(2).trim().split(/\s+/)[0]
    if (target && target.includes("python") && existsSync(target)) return target
  } catch {
    // puede ser un binario compilado; se usa EDGE_BIN directo
  }
  return undefined
}

const EDGE_PYTHON = findEdgePython()

const ENGINE_PREF = (process.env.OPENCODE_TTS_ENGINE ?? "auto").toLowerCase()
/** Motor de lectura vigente. Se puede cambiar desde Ajustes sin reiniciar. */
let ENGINE: "edge" | "say" = ENGINE_PREF === "say" || (ENGINE_PREF === "auto" && !EDGE_BIN) ? "say" : "edge"

const EDGE_VOICE_FEM = process.env.OPENCODE_TTS_VOICE ?? "es-MX-DaliaNeural"
const EDGE_VOICE_MASC = process.env.OPENCODE_TTS_MALE_VOICE ?? "es-HN-CarlosNeural"
const EDGE_RATE = process.env.OPENCODE_TTS_RATE ?? "+0%"

const SAY_PREFERRED = process.env.OPENCODE_TTS_SAY_VOICE ?? "Mónica"
const SAY_PREFERRED_MASC = process.env.OPENCODE_TTS_SAY_MALE_VOICE ?? "Jorge"
const SAY_RATE = process.env.OPENCODE_TTS_RATE_SAY

/** Busca la mejor variante instalada (Premium > Enhanced > normal). */
function resolveSayVoice(preferred: string): string {
  try {
    const lines = execFileSync("say", ["-v", "?"], { encoding: "utf8" }).split("\n")
    const spanish = lines
      .filter((line) => /\bes_[A-Z]{2}\b/.test(line))
      .map((line) => line.trim().split(/\s{2,}/)[0])
      .filter(Boolean)

    const bare = (name: string) =>
      name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s*\((enhanced|premium|mejorada|mejorado)\)\s*$/, "")
        .trim()

    const wanted = bare(preferred)
    const matches = spanish.filter((name) => bare(name) === wanted || name.toLowerCase().includes(preferred.toLowerCase()))
    const rank = (name: string) =>
      /\((premium)\)/i.test(name) ? 3 : /\((enhanced|mejorada|mejorado)\)/i.test(name) ? 2 : 1

    return matches.sort((a, b) => rank(b) - rank(a))[0] ?? preferred
  } catch {
    return preferred
  }
}

const SAY_VOICE_FEM = resolveSayVoice(SAY_PREFERRED)
const SAY_VOICE_MASC = resolveSayVoice(SAY_PREFERRED_MASC)

function clean(markdown: string): string {
  let text = markdown
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}…`
  return text
}

// Prompts de terminal (Linux/SSH "usuario@servidor:~$ ...", "(venv) root@vps:/var#", macOS "usuario ~ % ...", "$ ...")
const RE_PROMPT_CON_HOST = /^(?:\([^)]+\)\s*)?[\w.-]+@[\w.-]+:[^\s]*\s*[$#%](?:\s|$)/
const RE_PROMPT_MACOS = /^(?:\([^)]+\)\s*)?[\w.-]+\s+(?:~[^\s]*|\/[^\s]*|[\w.-]+)\s+[%#](?:\s|$)/
const RE_PROMPT_SIMBOLO = /^(?:\$\s+\S|zsh:\s|bash:\s|sh:\s)/
const RE_PROMPT_VACIO =
  /^(?:\([^)]+\)\s*)?(?:[\w.-]+@[\w.-]+:[^\s]*\s*[$#%]$|[\w.-]+\s+(?:~[^\s]*|\/[^\s]*|[\w.-]+)\s+[%#]$)/

function esPromptTerminal(linea: string): boolean {
  const t = linea.trim()
  if (!t) return false
  return RE_PROMPT_CON_HOST.test(t) || RE_PROMPT_MACOS.test(t) || RE_PROMPT_SIMBOLO.test(t)
}

function esPromptVacio(linea: string): boolean {
  const t = linea.trim()
  if (!t) return false
  return RE_PROMPT_VACIO.test(t)
}

/** Detecta líneas que parecen código o salida de terminal para no leerlas en voz alta. */
function esLineaDeCodigo(linea: string): boolean {
  const t = linea.trim()
  if (!t) return false
  if (/^[{}[\]();,]+$/.test(t)) return true
  // Prompts de consola (Linux/SSH, macOS zsh/bash, "$ ...", "zsh: ...")
  if (esPromptTerminal(linea)) return true
  // Salidas en columnas alineadas con varios espacios (systemctl, free -m, ps, df, docker, etc.)
  const columnas = t.split(/\s{2,}/)
  if (columnas.length >= 3) return true
  if (columnas.length === 2 && /^[a-zA-Z0-9_.@/-]+:?$/.test(columnas[0] ?? "")) return true
  // Unidades de systemd, permisos ls -l, cabeceras/resúmenes técnicos y logs con fecha/hora
  if (/\b[\w@.-]+\.(?:service|socket|timer|mount|target|slice|scope)\b/.test(t)) return true
  if (/^[dlcbps-][rwxstST-]{9}[+@.]?\s+\d+\s+/.test(t)) return true
  if (/^(?:Legend:|Mem:|Swap:|\d+\s+loaded\s+units\s+listed\.)/.test(t)) return true
  if (/^\s+[A-Z_]{2,}\s*(?:→|->|:)\s/.test(linea)) return true
  if (/^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\b/.test(t)) return true
  // Trazas de error o rutas con número de línea
  if (/^at\s+\S+\s*\(/.test(t) || /^File\s+"[^"]+",\s+line\s+\d+/.test(t) || /\.[a-z]{1,4}:\d+(?::\d+)?\b/.test(t)) {
    return true
  }
  // Comienzos típicos de sentencias de código
  if (
    /^(?:import|export|const|let|var|function|async\s+function|class|interface|type|return|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|catch\s*\(|def\s+\w+|from\s+\S+\s+import|public\s+|private\s+|readonly\s+|#include|package\s+)/.test(
      t,
    )
  ) {
    return true
  }
  // Etiquetas HTML/XML (p. ej. "<div class=...>", "<!DOCTYPE html>", "<!-- ... -->")
  if (/^<\/?[a-z!][\w:-]*(?:\s[^>]*)?>$/i.test(t) || /<[a-z][\w:-]*\s+[\w:-]+\s*=/i.test(t)) return true
  // Terminaciones u operadores muy propios de código
  if (/(?:=>|===|!==|&&|\|\||::|<\/|\/>|\bconsole\.|\bprocess\.|\bwindow\.)/.test(t)) return true
  if (/[;{}=]$/.test(t) || /(?:[}\])][;,])$/.test(t)) return true
  // Línea indentada con símbolos de código
  if (/^(?:\t|  +)/.test(linea) && /[{}[\]();=<>]/.test(t)) return true
  // Alta densidad de símbolos de código
  const sinEspacios = t.replace(/\s+/g, "")
  const simbolos = (sinEspacios.match(/[{}[\]();=<>|/\\*&^%$#@~`]/g) ?? []).length
  if (simbolos >= 3 && simbolos / sinEspacios.length >= 0.25) return true
  return false
}

/** Limpia un mensaje del usuario omitiendo bloques de código, capturas de terminal, HTML pegado y líneas técnicas. */
function limpiarMensajeUsuario(texto: string): string {
  const sinBloques = texto
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/<!DOCTYPE\s+html\b[\s\S]*?(?:<\/html>|$)/gi, "\n")
    .replace(/<html\b[\s\S]*?(?:<\/html>|$)/gi, "\n")
    .replace(/<(script|style|svg|head|noscript)\b[\s\S]*?(?:<\/\1>|$)/gi, "\n")

  const lineas = sinBloques.split(/\r?\n/)
  const lineasLegibles: string[] = []
  let enTerminal = false
  let tieneCierrePrompt = false

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i] ?? ""
    if (esPromptTerminal(linea)) {
      if (esPromptVacio(linea)) {
        enTerminal = false
        tieneCierrePrompt = false
      } else {
        enTerminal = true
        // Busca si más adelante hay un prompt vacío que cierre esta captura
        tieneCierrePrompt = false
        for (let j = i + 1; j < lineas.length; j++) {
          const sig = lineas[j] ?? ""
          if (esPromptVacio(sig)) {
            tieneCierrePrompt = true
            break
          }
          // Si aparece otro prompt con comando tras una línea en blanco y prosa, este bloque ya había terminado antes
          if (esPromptTerminal(sig)) {
            const prev = lineas[j - 1]?.trim() ?? ""
            if (!prev) break
          }
        }
      }
      continue
    }
    if (enTerminal) {
      if (tieneCierrePrompt) continue
      if (!linea.trim()) {
        const siguiente = lineas.slice(i + 1).find((l) => l.trim().length > 0)
        if (siguiente && !esPromptTerminal(siguiente) && !esLineaDeCodigo(siguiente)) {
          enTerminal = false
        }
      }
      continue
    }
    if (!esLineaDeCodigo(linea)) lineasLegibles.push(linea)
  }

  return clean(lineasLegibles.join(" "))
}

/**
 * Trabajador persistente de edge-tts en Python.
 * Mantiene edge_tts y aiohttp cargados en memoria para evitar ~500 ms de arranque
 * en cada oración y permite sintetizar varias oraciones en paralelo.
 */
const EDGE_WORKER_PY = `
import asyncio, json, sys, edge_tts

tasks = {}

async def handle(req):
    req_id = req["id"]
    try:
        comm = edge_tts.Communicate(req["text"], req["voice"], rate=req.get("rate") or "+0%")
        await comm.save(req["out"])
        sys.stdout.write(json.dumps({"id": req_id, "ok": True}) + "\\n")
    except asyncio.CancelledError:
        sys.stdout.write(json.dumps({"id": req_id, "ok": False, "cancelled": True}) + "\\n")
    except Exception as e:
        sys.stdout.write(json.dumps({"id": req_id, "ok": False, "err": str(e)}) + "\\n")
    finally:
        tasks.pop(req_id, None)
        sys.stdout.flush()

async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    sys.stdout.write('{"ready":true}\\n')
    sys.stdout.flush()
    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            req = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if req.get("cmd") == "cancel":
            t = tasks.get(req.get("id"))
            if t:
                t.cancel()
            continue
        if req.get("cmd") == "quit":
            break
        t = asyncio.create_task(handle(req))
        tasks[req["id"]] = t
    for t in list(tasks.values()):
        t.cancel()
    if tasks:
        await asyncio.gather(*tasks.values(), return_exceptions=True)

asyncio.run(main())
`.trim()

/**
 * Reproductor persistente nativo de macOS vía JXA (AVAudioPlayer).
 * Duerme sin usar CPU entre audios, arranca en milisegundos y pausa/retoma
 * en el instante exacto leyendo un archivo de control mientras reproduce.
 */
const PLAYER_WORKER_JXA = `
ObjC.import("AVFoundation");
ObjC.import("Foundation");
var fm = $.NSFileManager.defaultManager;
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  var s = $.NSString.stringWithString(JSON.stringify(obj) + "\\n");
  stdout.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
}
function readCtrl(path) {
  if (!path || !fm.fileExistsAtPath(path)) return "";
  var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s ? s.js.trim() : "";
}
send({ ready: true });
var buf = "";
var salir = false;
while (!salir) {
  var data = stdin.availableData;
  if (!data || Number(data.length) === 0) break;
  var chunk = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (!chunk) continue;
  buf += chunk.js;
  var nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    var line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    var req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    if (req.quit) { salir = true; break; }
    var url = $.NSURL.fileURLWithPath(req.file);
    var p = $.AVAudioPlayer.alloc.initWithContentsOfURLError(url, $());
    if (!p || !p.prepareToPlay || !p.play) {
      send({ id: req.id, ok: false });
      continue;
    }
    var paused = false;
    var stopped = false;
    while (true) {
      var cmd = readCtrl(req.ctrl);
      if (cmd === "stop") { p.stop; stopped = true; break; }
      if (cmd === "pause" && !paused) { p.pause; paused = true; }
      else if (cmd !== "pause" && paused) { p.prepareToPlay; p.play; paused = false; $.NSThread.sleepForTimeInterval(0.05); continue; }
      if (!paused && !p.playing) break;
      $.NSThread.sleepForTimeInterval(0.03);
    }
    send({ id: req.id, ok: !stopped });
  }
}
`.trim()

function borrarSilencioso(path: string) {
  try {
    rmSync(path, { force: true })
  } catch {
    // ignora
  }
}

type BloqueStream = {
  pendiente: string
  enCodigo: boolean
  emitidos: number
  charsEnviados: number
}

/**
 * Extrae oraciones listas del buffer de streaming sin leer bloques de código
 * ni cortar numeraciones cortas (como "1. ").
 */
function extraerOraciones(bloque: BloqueStream, delta: string): string[] {
  bloque.pendiente += delta
  const listas: string[] = []

  const empujar = (bruto: string) => {
    const limpio = clean(bruto)
    if (limpio.length <= 1 || /^\d+[.)]$/.test(limpio)) return
    const restante = MAX_CHARS - bloque.charsEnviados
    if (restante <= 0) return
    const recorte = limpio.length > restante ? `${limpio.slice(0, restante)}…` : limpio
    bloque.charsEnviados += recorte.length
    bloque.emitidos += 1
    listas.push(recorte)
  }

  while (bloque.pendiente.length > 0) {
    if (bloque.enCodigo) {
      const cierre = bloque.pendiente.indexOf("```")
      if (cierre === -1) {
        // Conserva hasta 2 caracteres por si ``` viene partido entre dos deltas.
        if (bloque.pendiente.length > 2) bloque.pendiente = bloque.pendiente.slice(-2)
        break
      }
      bloque.pendiente = bloque.pendiente.slice(cierre + 3)
      bloque.enCodigo = false
      continue
    }

    const apertura = bloque.pendiente.indexOf("```")
    if (apertura !== -1) {
      const antes = bloque.pendiente.slice(0, apertura)
      if (antes.trim()) empujar(antes)
      bloque.pendiente = bloque.pendiente.slice(apertura + 3)
      bloque.enCodigo = true
      continue
    }

    // No cortar sobre backticks al final por si está arrancando un ```.
    const seguro = bloque.pendiente.endsWith("``")
      ? bloque.pendiente.slice(0, -2)
      : bloque.pendiente.endsWith("`")
        ? bloque.pendiente.slice(0, -1)
        : bloque.pendiente

    const minChars = bloque.emitidos === 0 ? 8 : 28
    let corte = -1

    // 1) Fin de oración (. ! ? …) seguido de espacio o salto de línea, o salto de línea.
    const reOracion = /(?:[.!?…](?=\s)|\n)/g
    let match: RegExpExecArray | null
    while ((match = reOracion.exec(seguro)) !== null) {
      const fin = match.index + match[0].length
      const candidato = clean(seguro.slice(0, fin))
      if (candidato.length >= minChars && !/^\d+[.)]$/.test(candidato)) {
        corte = fin
        break
      }
    }

    // 2) Si la oración es muy larga sin punto, corta en una pausa natural (, ; :).
    if (corte === -1 && clean(seguro).length >= 180) {
      const rePausa = /[,;:](?=\s)/g
      while ((match = rePausa.exec(seguro)) !== null) {
        const fin = match.index + match[0].length
        if (clean(seguro.slice(0, fin)).length >= 60) {
          corte = fin
          break
        }
      }
    }

    if (corte === -1) break
    empujar(bloque.pendiente.slice(0, corte))
    bloque.pendiente = bloque.pendiente.slice(corte)
  }

  return listas
}

function vaciarBloque(bloque: BloqueStream): string | undefined {
  if (bloque.enCodigo) return undefined
  const limpio = clean(bloque.pendiente)
  bloque.pendiente = ""
  if (limpio.length <= 1 || /^\d+[.)]$/.test(limpio)) return undefined
  const restante = MAX_CHARS - bloque.charsEnviados
  if (restante <= 0) return undefined
  const recorte = limpio.length > restante ? `${limpio.slice(0, restante)}…` : limpio
  bloque.charsEnviados += recorte.length
  return recorte
}

const NOMBRES_HERRAMIENTAS: Record<string, string> = {
  read: "Leer",
  edit: "Editar",
  write: "Escribir",
  shell: "Terminal",
  bash: "Terminal",
  grep: "Buscar en archivos",
  glob: "Buscar archivos",
  webfetch: "Abrir web",
  websearch: "Buscar en la web",
  subagent: "Subagente",
  question: "Pregunta",
  execute: "Ejecutar",
  skill: "Habilidad",
}

const FRASES_PERMISO_RESPUESTA: Record<string, string> = {
  once: "Permitido una vez.",
  always: "Permitido siempre.",
  reject: "Permiso rechazado.",
}

function nombreHerramienta(name: string): string {
  return NOMBRES_HERRAMIENTAS[name.toLowerCase()] ?? name.replace(/[_-]+/g, " ")
}

function fraseHerramientas(conteo: Map<string, number>): string | undefined {
  const partes = Array.from(conteo.entries()).map(([nombre, n]) => (n > 1 ? `${n} ${nombre}` : nombre))
  if (partes.length === 0) return undefined
  if (partes.length === 1) return `Usando ${partes[0]}.`
  const ultima = partes.pop()
  return `Usando ${partes.join(", ")} y ${ultima}.`
}

/**
 * Busca una clave de API en el entorno o en archivos .env locales (por ejemplo
 * ~/.config/opencode/.env), porque las apps de escritorio en macOS suelen no heredar el .zshrc.
 */
function buscarClaveEnv(nombre: string): string | undefined {
  const directa = process.env[nombre]?.trim()
  if (directa) return directa

  const home = process.env.HOME ?? ""
  const rutas = [
    join(home, ".hermes/.env"),
    join(home, ".config/opencode/.env"),
    join(home, ".env"),
  ]
  for (const ruta of rutas) {
    if (!existsSync(ruta)) continue
    try {
      const lineas = readFileSync(ruta, "utf8").split(/\r?\n/)
      for (const linea of lineas) {
        const limpia = linea.trim()
        if (!limpia || limpia.startsWith("#")) continue
        const sinExport = limpia.startsWith("export ") ? limpia.slice(7).trim() : limpia
        const eq = sinExport.indexOf("=")
        if (eq <= 0) continue
        const clave = sinExport.slice(0, eq).trim()
        if (clave !== nombre) continue
        let valor = sinExport.slice(eq + 1).trim()
        if (
          (valor.startsWith('"') && valor.endsWith('"')) ||
          (valor.startsWith("'") && valor.endsWith("'"))
        ) {
          valor = valor.slice(1, -1)
        }
        if (valor) return valor
      }
    } catch {
      // ignora archivos ilegibles
    }
  }
  return undefined
}

const MAX_ELEVENLABS_KEYTERMS = 100
const MAX_KEYTERM_CHARS = 50
const MAX_KEYTERM_WORDS = 5
const MAX_GROQ_VOCAB_CHARS = 600
const KEYTERM_PROHIBIDOS = /[<>{}[\]\\]/

let cacheVocab: { ruta: string; mtimeMs: number; terminos: string[] } | undefined

function rutaVocabulario(): string {
  const desdeEnv = process.env.OPENCODE_STT_VOCAB_FILE?.trim()
  if (desdeEnv) {
    return desdeEnv.startsWith("~/") ? join(process.env.HOME ?? "", desdeEnv.slice(2)) : desdeEnv
  }
  return join(process.env.HOME ?? "", ".config/opencode/voz-vocabulario.md")
}

/**
 * Lee el vocabulario de voz (una palabra o frase por línea, ignorando líneas
 * vacías y comentarios con #). Se recarga solo cuando cambia el archivo.
 */
function cargarVocabulario(): string[] {
  const ruta = rutaVocabulario()
  if (!ruta || !existsSync(ruta)) return []
  try {
    const mtimeMs = statSync(ruta).mtimeMs
    if (cacheVocab && cacheVocab.ruta === ruta && cacheVocab.mtimeMs === mtimeMs) {
      return cacheVocab.terminos
    }
    const vistos = new Set<string>()
    const terminos: string[] = []
    for (const raw of readFileSync(ruta, "utf8").split(/\r?\n/)) {
      const limpia = raw.trim().replace(/\s+/g, " ")
      if (!limpia || limpia.startsWith("#")) continue
      const clave = limpia.toLowerCase()
      if (vistos.has(clave)) continue
      vistos.add(clave)
      terminos.push(limpia)
    }
    cacheVocab = { ruta, mtimeMs, terminos }
    return terminos
  } catch {
    return []
  }
}

function agregarAlVocabulario(entrada: string): {
  ok: boolean
  agregado: boolean
  termino: string
  total: number
  error?: string
} {
  const limpio = entrada.trim().replace(/\s+/g, " ")
  if (!limpio) {
    return { ok: false, agregado: false, termino: "", total: cargarVocabulario().length, error: "Escribí una palabra o frase para agregar." }
  }
  const ruta = rutaVocabulario()
  if (!ruta) {
    return { ok: false, agregado: false, termino: limpio, total: 0, error: "No se encontró la ruta del vocabulario." }
  }
  try {
    const existentes = cargarVocabulario()
    const yaExiste = existentes.some((t) => t.toLowerCase() === limpio.toLowerCase())
    if (yaExiste) {
      return { ok: true, agregado: false, termino: limpio, total: existentes.length }
    }
    mkdirSync(dirname(ruta), { recursive: true })
    if (existsSync(ruta)) {
      const actual = readFileSync(ruta, "utf8")
      const sep = actual.length === 0 || actual.endsWith("\n") ? "" : "\n"
      writeFileSync(ruta, `${actual}${sep}${limpio}\n`, "utf8")
    } else {
      writeFileSync(
        ruta,
        `# Vocabulario de dictado por voz (una palabra o frase por línea)\n${limpio}\n`,
        "utf8",
      )
    }
    cacheVocab = undefined
    const total = cargarVocabulario().length
    return { ok: true, agregado: true, termino: limpio, total }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, agregado: false, termino: limpio, total: cargarVocabulario().length, error: msg }
  }
}

function keytermsParaElevenLabs(terminos: string[]): string[] {
  const validos: string[] = []
  for (const termino of terminos) {
    if (validos.length >= MAX_ELEVENLABS_KEYTERMS) break
    if (termino.length > MAX_KEYTERM_CHARS) continue
    if (termino.split(" ").length > MAX_KEYTERM_WORDS) continue
    if (KEYTERM_PROHIBIDOS.test(termino)) continue
    validos.push(termino)
  }
  return validos
}

function promptParaGroq(terminos: string[]): string | undefined {
  if (terminos.length === 0) return undefined
  let texto = `Vocabulario: ${terminos.join(", ")}.`
  if (texto.length > MAX_GROQ_VOCAB_CHARS) {
    const corte = texto.slice(0, MAX_GROQ_VOCAB_CHARS).lastIndexOf(",")
    texto = corte > 0 ? `${texto.slice(0, corte)}.` : `${texto.slice(0, MAX_GROQ_VOCAB_CHARS - 1)}.`
  }
  return texto
}

/** Versión del plugin que escribe el log (actualizar junto con package.json). */
const VERSION_LOG = "0.2.34"
const RUTA_LOG_DICTADO = join(process.env.HOME ?? tmpdir(), ".local/share/opencode/log/voz-dictado.log")
const MAX_LINEAS_LOG_DICTADO = 200
const RUTA_LOG_REMOTO = join(process.env.HOME ?? tmpdir(), ".local/share/opencode/log/voz-remoto.log")

/** Guarda en disco cada audio que se manda al STT, para poder recuperarlo. */
function guardarAudioDictado(audioBase64: string, mimeType: string) {
  try {
    mkdirSync(DIR_AUDIO_DICTADO, { recursive: true })
    const bytes = Buffer.from(audioBase64, "base64")
    const ext = mimeType.includes("mp4") ? "m4a" : "webm"
    const nombre = `${new Date().toISOString().replace(/[:.]/g, "-")}-${bytes.length}.${ext}`
    writeFileSync(join(DIR_AUDIO_DICTADO, nombre), bytes)
    const viejos = readdirSync(DIR_AUDIO_DICTADO)
      .filter((n) => /\.(webm|m4a)$/.test(n))
      .map((n) => ({ n, t: statSync(join(DIR_AUDIO_DICTADO, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const viejo of viejos.slice(MAX_AUDIOS_DICTADO)) {
      rmSync(join(DIR_AUDIO_DICTADO, viejo.n), { force: true })
    }
    registrarLogRemoto(`audio guardado nombre=${nombre} bytes=${bytes.length}`)
  } catch {
    // el backup es auxiliar: si falla, la transcripción sigue igual
  }
}

function registrarLogRemoto(mensaje: string) {
  try {
    mkdirSync(dirname(RUTA_LOG_REMOTO), { recursive: true })
    appendFileSync(RUTA_LOG_REMOTO, `${new Date().toISOString()} v${VERSION_LOG} ${mensaje}\n`, "utf8")
  } catch {
    // diagnóstico auxiliar
  }
}

/**
 * Anota cada intento de dictado en un log propio, porque el error que se
 * muestra en pantalla se pierde apenas se cierra el diálogo.
 */
function registrarLogDictado(mensaje: string) {
  try {
    mkdirSync(dirname(RUTA_LOG_DICTADO), { recursive: true })
    const lineas = existsSync(RUTA_LOG_DICTADO)
      ? readFileSync(RUTA_LOG_DICTADO, "utf8").split(/\r?\n/).filter((l) => l.trim())
      : []
    if (lineas.length >= MAX_LINEAS_LOG_DICTADO) {
      writeFileSync(RUTA_LOG_DICTADO, `${lineas.slice(-Math.floor(MAX_LINEAS_LOG_DICTADO / 2)).join("\n")}\n`, "utf8")
    }
    appendFileSync(RUTA_LOG_DICTADO, `${new Date().toISOString()} v${VERSION_LOG} ${mensaje}\n`, "utf8")
  } catch {
    // el log es auxiliar: si no se puede escribir, el dictado sigue igual
  }
}

async function transcribirConElevenLabs(
  bytes: Uint8Array,
  mimeType: string,
  nombreArchivo: string,
  apiKey: string,
  vocabulario: string[],
): Promise<string> {
  const modelId = process.env.OPENCODE_STT_ELEVENLABS_MODEL ?? "scribe_v3"
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: mimeType }), nombreArchivo)
  form.append("model_id", modelId)
  form.append("language_code", process.env.OPENCODE_STT_LANG ?? "spa")
  form.append("tag_audio_events", "false")
  if (modelId !== "scribe_v1") {
    for (const termino of keytermsParaElevenLabs(vocabulario)) {
      form.append("keyterms", termino)
    }
  }

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  })
  if (!res.ok) {
    const detalle = await res.text().catch(() => "")
    throw new Error(`ElevenLabs (${res.status}): ${detalle.slice(0, 400)}`)
  }
  const data = (await res.json()) as { text?: string }
  return (data.text ?? "").trim()
}

async function transcribirConGroq(
  bytes: Uint8Array,
  mimeType: string,
  nombreArchivo: string,
  apiKey: string,
  vocabulario: string[],
): Promise<string> {
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: mimeType }), nombreArchivo)
  form.append("model", process.env.OPENCODE_STT_GROQ_MODEL ?? "whisper-large-v3-turbo")
  form.append("language", process.env.OPENCODE_STT_GROQ_LANG ?? "es")
  const prompt = promptParaGroq(vocabulario)
  if (prompt) form.append("prompt", prompt)

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const detalle = await res.text().catch(() => "")
    throw new Error(`Groq (${res.status}): ${detalle.slice(0, 400)}`)
  }
  const data = (await res.json()) as { text?: string }
  return (data.text ?? "").trim()
}

async function transcribirAudio(
  audioBase64: string,
  mimeType: string,
  motor: MotorStt = "auto",
): Promise<{ text: string; error?: string }> {
  const bytes = new Uint8Array(Buffer.from(audioBase64, "base64"))
  if (bytes.byteLength < 100) {
    registrarLogDictado(`motor=${motor} audio descartado: ${bytes.byteLength} bytes`)
    return { text: "" }
  }

  const mime = mimeType || "audio/webm"
  const nombreArchivo = mime.includes("mp4") || mime.includes("m4a")
    ? "audio.m4a"
    : mime.includes("wav")
      ? "audio.wav"
      : "audio.webm"

  const elevenKey = buscarClaveEnv("ELEVENLABS_API_KEY")
  const groqKey = buscarClaveEnv("GROQ_API_KEY")

  if (motor === "elevenlabs" && !elevenKey) {
    registrarLogDictado("motor=elevenlabs error: falta la clave ELEVENLABS_API_KEY")
    return { text: "", error: "Falta ELEVENLABS_API_KEY: no puedo dictar con ElevenLabs." }
  }
  if (motor === "groq" && !groqKey) {
    registrarLogDictado("motor=groq error: falta la clave GROQ_API_KEY")
    return { text: "", error: "Falta GROQ_API_KEY: no puedo dictar con Groq." }
  }
  if (!elevenKey && !groqKey) {
    registrarLogDictado("motor=auto error: faltan ELEVENLABS_API_KEY y GROQ_API_KEY")
    return {
      text: "",
      error: "Faltan ELEVENLABS_API_KEY y GROQ_API_KEY: no hay motor de dictado disponible.",
    }
  }

  const vocabulario = cargarVocabulario()
  const modelEleven = process.env.OPENCODE_STT_ELEVENLABS_MODEL ?? "scribe_v3"
  const keytermsEleven = modelEleven !== "scribe_v1" ? keytermsParaElevenLabs(vocabulario) : []
  const promptGroq = promptParaGroq(vocabulario)
  const detalleVocab = (proveedor: "elevenlabs" | "groq") => {
    if (proveedor === "groq") {
      return promptGroq
        ? `vocab=si terminos=${vocabulario.length} prompt_chars=${promptGroq.length}`
        : `vocab=no terminos=${vocabulario.length}`
    }
    return keytermsEleven.length > 0
      ? `vocab=si terminos=${vocabulario.length} keyterms=${keytermsEleven.length}`
      : `vocab=no terminos=${vocabulario.length}`
  }

  const intentos: Array<{ nombre: "elevenlabs" | "groq"; correr: () => Promise<string> }> = []
  if (motor !== "groq" && elevenKey) {
    intentos.push({
      nombre: "elevenlabs",
      correr: () => transcribirConElevenLabs(bytes, mime, nombreArchivo, elevenKey, vocabulario),
    })
  }
  if (motor !== "elevenlabs" && groqKey) {
    intentos.push({
      nombre: "groq",
      correr: () => transcribirConGroq(bytes, mime, nombreArchivo, groqKey, vocabulario),
    })
  }
  if (motor === "auto") {
    if (!elevenKey) registrarLogDictado("motor=auto aviso: falta ELEVENLABS_API_KEY, dicto con Groq")
    if (!groqKey) registrarLogDictado("motor=auto aviso: falta GROQ_API_KEY, dicto sin respaldo")
  }

  let ultimoError = ""
  for (const intento of intentos) {
    const inicio = Date.now()
    try {
      const texto = await intento.correr()
      registrarLogDictado(
        `motor=${motor} ok proveedor=${intento.nombre} ${detalleVocab(intento.nombre)} ms=${Date.now() - inicio} caracteres=${texto.length}`,
      )
      return { text: texto }
    } catch (err) {
      ultimoError = err instanceof Error ? err.message : String(err)
      registrarLogDictado(
        `motor=${motor} fallo proveedor=${intento.nombre} ${detalleVocab(intento.nombre)} ms=${Date.now() - inicio} error=${ultimoError.slice(0, 300)}`,
      )
    }
  }
  return { text: "", error: ultimoError || "No se pudo transcribir el audio." }
}

function tmpFile(): string {
  return join(tmpdir(), `${TMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`)
}

export default Plugin.define({
  id: "voz",
  async setup(ctx) {
    registrarLogRemoto(`arranque plugin v${VERSION_LOG}`)
    let genero: GeneroVoz = "fem"
    let motor: MotorStt = "auto"
    let muted = (await ctx.storage.get("muted")) === true
    let hablando = false
    let pausado = false
    /** Hay audio encolado esperando a que termine el que está sonando (otra instancia u otra voz). */
    let enCola = false
    /** Síntesis MP3 en vuelo: el pill muestra "Sintetizando..." hasta que empieza a sonar. */
    let sintetizando = 0
    /** Reproducciones en curso: con audio sonando el pill siempre dice "Pausar voz". */
    let reproduciendo = 0
    let pendientes = 0
    let queue: Promise<void> = Promise.resolve()
    let generation = 0
    const running = new Set<ChildProcess>()
    let reproductorSay: ChildProcess | undefined
    let archivoCtrl: string | undefined
    let esperarReanudar: (() => void) | undefined
    type UltimoMensajeSesion = { msgId: string; archivos: string[]; texto: string }
    const MAX_AUDIOS_POR_SESION = 2
    const MAX_SESIONES_AUDIO = 2
    const ultimosPorSesion = new Map<string, UltimoMensajeSesion[]>()
    const indiceAudioPorSesion = new Map<string, number>()

    /** Caché de audios persistida: sin esto, recargar OpenCode vacía la memoria y "Escuchar" queda apagado. */
    const CLAVE_CACHE_AUDIOS = "cacheAudios"
    type CacheAudios = { sesiones?: [string, UltimoMensajeSesion[]][]; indices?: [string, number][] }
    let timerGuardarCache: ReturnType<typeof setTimeout> | undefined

    function guardarCacheAudios() {
      if (timerGuardarCache) clearTimeout(timerGuardarCache)
      timerGuardarCache = setTimeout(() => {
        timerGuardarCache = undefined
        try {
          const valor: CacheAudios = {
            sesiones: Array.from(ultimosPorSesion.entries()),
            indices: Array.from(indiceAudioPorSesion.entries()),
          }
          void ctx.storage.set(CLAVE_CACHE_AUDIOS, valor)
        } catch {
          // si no se pudo guardar, la caché queda solo en memoria
        }
      }, 400)
    }

    async function cargarCacheAudios() {
      try {
        const guardado = (await ctx.storage.get(CLAVE_CACHE_AUDIOS)) as CacheAudios | undefined
        if (!guardado?.sesiones?.length) return
        for (const [sessionID, mensajes] of guardado.sesiones) {
          if (typeof sessionID !== "string" || !Array.isArray(mensajes)) continue
          const validos = mensajes
            .filter(
              (m) =>
                m &&
                typeof m.msgId === "string" &&
                typeof m.texto === "string" &&
                Array.isArray(m.archivos) &&
                m.archivos.every((f) => typeof f === "string"),
            )
            .slice(-MAX_AUDIOS_POR_SESION)
            .map((m) => ({ ...m, archivos: m.archivos.filter((f) => existsSync(f)) }))
            .filter((m) => m.archivos.length > 0 || m.texto.trim().length > 0)
          if (validos.length) ultimosPorSesion.set(sessionID, validos)
          if (ultimosPorSesion.size > MAX_SESIONES_AUDIO) {
            const primera = ultimosPorSesion.keys().next().value
            if (primera && primera !== sessionID) ultimosPorSesion.delete(primera)
          }
        }
        for (const [sessionID, indice] of guardado.indices ?? []) {
          const mensajes = ultimosPorSesion.get(sessionID)
          if (mensajes && typeof indice === "number" && indice >= 0) {
            // El índice guardado puede quedar fuera de rango si se recortó la caché.
            indiceAudioPorSesion.set(sessionID, Math.min(indice, mensajes.length - 1))
          }
        }
      } catch {
        // sin caché guardada: arranca vacío y se llena con lo que se lea ahora
      }
    }

    await cargarCacheAudios()
    let mensajeActual: string | undefined
    let yaDijoTrabajando = false
    let ejecutando = false
    let esperandoPermiso = false
    let trabajandoEnCola = false
    let leyendoEcoUsuario = false
    let leyendoAvisoHerramienta = false
    let proximoAvisoEn = 0
    let proximoMensajeDictadoHasta = 0
    let turnoFueDictado = false
    let respondioEnEsteTurno = false
    let sesionRespuesta: string | undefined
    let sesionHablando: string | undefined
    let turnoActivo: string | undefined
    let sesionEco: string | undefined
    let turnoEco: string | undefined
    let timerPrimerTrabajando: ReturnType<typeof setTimeout> | undefined
    let timerTrabajando: ReturnType<typeof setTimeout> | undefined
    const cacheAvisos = new Map<string, string>()
    const avisosEnCurso = new Map<string, Promise<string | undefined>>()
    const herramientasVistas = new Set<string>()
    const herramientasPendientes = new Map<string, number>()
    let timerHerramientas: ReturnType<typeof setTimeout> | undefined
    const spoken = new Map<string, number>()
    const bloques = new Map<string, BloqueStream>()

    let nextReqId = 1
    let edgeWorker: ChildProcess | undefined
    const edgePendientes = new Map<number, (ok: boolean) => void>()
    let playerWorker: ChildProcess | undefined
    const playerPendientes = new Map<number, (ok: boolean) => void>()

    function asegurarEdgeWorker(): ChildProcess | undefined {
      if (!EDGE_PYTHON) return undefined
      if (edgeWorker && !edgeWorker.killed && edgeWorker.exitCode === null) return edgeWorker

      const child = spawn(EDGE_PYTHON, ["-u", "-c", EDGE_WORKER_PY], {
        stdio: ["pipe", "pipe", "ignore"],
      })
      edgeWorker = child
      let buf = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        let nl: number
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as { id?: number; ok?: boolean }
            if (typeof msg.id === "number") {
              const resolver = edgePendientes.get(msg.id)
              if (resolver) {
                edgePendientes.delete(msg.id)
                resolver(msg.ok === true)
              }
            }
          } catch {
            // ignora líneas sueltas
          }
        }
      })
      const limpiar = () => {
        if (edgeWorker === child) edgeWorker = undefined
        for (const [, resolver] of edgePendientes) resolver(false)
        edgePendientes.clear()
      }
      child.on("error", limpiar)
      child.on("close", limpiar)
      return child
    }

    function asegurarPlayerWorker(): ChildProcess {
      if (playerWorker && !playerWorker.killed && playerWorker.exitCode === null) return playerWorker

      const child = spawn("osascript", ["-l", "JavaScript", "-e", PLAYER_WORKER_JXA], {
        stdio: ["pipe", "pipe", "ignore"],
      })
      playerWorker = child
      let buf = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        let nl: number
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as { id?: number; ok?: boolean }
            if (typeof msg.id === "number") {
              const resolver = playerPendientes.get(msg.id)
              if (resolver) {
                playerPendientes.delete(msg.id)
                resolver(msg.ok === true)
              }
            }
          } catch {
            // ignora
          }
        }
      })
      const limpiar = () => {
        if (playerWorker === child) playerWorker = undefined
        for (const [, resolver] of playerPendientes) resolver(false)
        playerPendientes.clear()
      }
      child.on("error", limpiar)
      child.on("close", limpiar)
      return child
    }

    function precalentar() {
      if (motorVozActual() === "edge" && EDGE_PYTHON) asegurarEdgeWorker()
      if (motorVozActual() === "edge") {
        asegurarPlayerWorker()
        void asegurarAudioAviso("Trabajando.")
        void asegurarAudioAviso("Permiso pendiente.")
      }
    }

    function cerrarTrabajadores() {
      if (edgeWorker) {
        try {
          edgeWorker.stdin?.write('{"cmd":"quit"}\n')
          edgeWorker.stdin?.end()
          edgeWorker.kill("SIGTERM")
        } catch {
          // ignora
        }
        edgeWorker = undefined
      }
      if (playerWorker) {
        try {
          playerWorker.stdin?.write('{"quit":true}\n')
          playerWorker.stdin?.end()
          playerWorker.kill("SIGTERM")
        } catch {
          // ignora
        }
        playerWorker = undefined
      }
    }

    const savedGenero = await ctx.storage.get("genero")
    const savedVoice = await ctx.storage.get("voice")
    if (savedGenero === "masc" || savedVoice === EDGE_VOICE_MASC) {
      genero = "masc"
    }
    const generoCompartido = leerEstadoGenero()
    if (generoCompartido) genero = generoCompartido

    const savedMotor = await ctx.storage.get("motor")
    if (savedMotor === "elevenlabs" || savedMotor === "groq" || savedMotor === "auto") {
      motor = savedMotor
    }
    const motorCompartido = leerEstadoMotor()
    if (motorCompartido) motor = motorCompartido

    function motorActual(): MotorStt {
      const compartido = leerEstadoMotor()
      if (compartido && compartido !== motor) motor = compartido
      return motor
    }

    const savedMotorVoz = await ctx.storage.get("motorVoz")
    if (savedMotorVoz === "edge" || savedMotorVoz === "say") {
      if (savedMotorVoz === "say" || EDGE_BIN) ENGINE = savedMotorVoz
    }
    const motorVozCompartido = leerEstadoMotorVoz()
    if (motorVozCompartido && (motorVozCompartido === "say" || EDGE_BIN)) ENGINE = motorVozCompartido

    function motorVozActual(): "edge" | "say" {
      const compartido = leerEstadoMotorVoz()
      if (compartido && compartido !== ENGINE && (compartido === "say" || EDGE_BIN)) ENGINE = compartido
      return ENGINE
    }

    let ecoActivo = (await ctx.storage.get("eco")) !== false
    const ecoCompartido = leerEstadoEcoActivo()
    if (ecoCompartido !== undefined) {
      ecoActivo = ecoCompartido
    } else if (!ecoActivo) {
      guardarEstadoEcoActivo(false)
    }

    function ecoActual(): boolean {
      const compartido = leerEstadoEcoActivo()
      if (compartido !== undefined && compartido !== ecoActivo) ecoActivo = compartido
      return ecoActivo
    }

    let concurrencia: ModoConcurrencia =
      (process.env.OPENCODE_TTS_CONCURRENCIA ?? "cortar").toLowerCase() === "esperar" ? "esperar" : "cortar"
    const savedConcurrencia = await ctx.storage.get("concurrencia")
    if (savedConcurrencia === "esperar" || savedConcurrencia === "cortar") {
      concurrencia = savedConcurrencia
    }
    const concurrenciaCompartida = leerEstadoConcurrencia()
    if (concurrenciaCompartida) {
      concurrencia = concurrenciaCompartida
    } else if (concurrencia === "esperar") {
      guardarEstadoConcurrencia("esperar")
    }

    function concurrenciaActual(): ModoConcurrencia {
      const compartido = leerEstadoConcurrencia()
      if (compartido && compartido !== concurrencia) concurrencia = compartido
      return concurrencia
    }

    const CLAVE_SESIONES_APAGADAS = "sesionesApagadas"
    let sesionesApagadas = new Set<string>()
    const guardadas = await ctx.storage.get(CLAVE_SESIONES_APAGADAS)
    if (Array.isArray(guardadas)) {
      sesionesApagadas = new Set(guardadas.filter((id): id is string => typeof id === "string"))
    }
    const compartidas = leerSesionesApagadas()
    if (compartidas) {
      sesionesApagadas = compartidas
    } else if (sesionesApagadas.size > 0) {
      guardarSesionesApagadas(sesionesApagadas)
    }
    let sesionActiva: string | undefined

    function sesionApagada(id: string | undefined) {
      if (!id) return false
      const actual = leerSesionesApagadas()
      if (actual) sesionesApagadas = actual
      return sesionesApagadas.has(id)
    }

    function sesionActualApagada() {
      return sesionApagada(sesionActiva)
    }

    async function alternarApagadoSesion(id: string) {
      const actual = leerSesionesApagadas()
      if (actual) sesionesApagadas = actual
      if (sesionesApagadas.has(id)) {
        sesionesApagadas.delete(id)
      } else {
        sesionesApagadas.add(id)
        if (sesionRespuesta === id || sesionActiva === id) {
          cancelarAutoEscucha()
        }
        if (sesionHablando === id || sesionEco === id || (!sesionHablando && sesionActiva === id)) {
          stopSpeaking(false)
        }
        cortarAudioGlobal(id)
      }
      guardarSesionesApagadas(sesionesApagadas)
      await ctx.storage.set(CLAVE_SESIONES_APAGADAS, Array.from(sesionesApagadas))
      return sesionesApagadas.has(id)
    }

    function generoActual(): GeneroVoz {
      const compartido = leerEstadoGenero()
      if (compartido && compartido !== genero) genero = compartido
      return genero
    }

    function vozEdgeActual(): string {
      return generoActual() === "masc" ? EDGE_VOICE_MASC : EDGE_VOICE_FEM
    }

    function vozSayActual(): string {
      return generoActual() === "masc" ? SAY_VOICE_MASC : SAY_VOICE_FEM
    }

    /** Nombre corto de la voz que lee, para mostrar en Ajustes (p. ej. "Edge - Dalia MX"). */
    function vozParaMostrar(): string {
      if (motorVozActual() === "say") return `macOS - ${vozSayActual()}`
      const id = vozEdgeActual()
      const partes = id.match(/^es-([a-z]{2})-(.+?)Neural$/i)
      return `Edge - ${partes ? `${partes[2]} ${partes[1].toUpperCase()}` : id}`
    }

    let avisar:
      | ((estado: {
          hablando: boolean
          pausado: boolean
          silenciado: boolean
          genero: GeneroVoz
          motor: MotorStt
          eco: boolean
          concurrencia: ModoConcurrencia
        }) => void)
      | undefined
    let avisarLecturaTerminada: ((sessionID?: string) => void) | undefined
    let avisarTurnoTerminado: ((sessionID?: string) => void) | undefined
    let avisarTextoParaLeer: ((texto: string, sessionID?: string) => void) | undefined

    function cancelarAutoEscucha() {
      turnoFueDictado = false
      respondioEnEsteTurno = false
      sesionRespuesta = undefined
    }

    function notificarTurnoTerminadoSiListo() {
      if (!respondioEnEsteTurno) return
      const idDestino = sesionRespuesta ?? sesionActiva
      if (sesionApagada(idDestino)) return
      if (ejecutando || alguienHablando() || pausado || muted || esperandoPermiso) return
      turnoFueDictado = false
      respondioEnEsteTurno = false
      sesionRespuesta = undefined
      avisarTurnoTerminado?.(idDestino)
    }

    function estadoActual() {
      return {
        hablando,
        enCola,
        sintetizando: sintetizando > 0,
        reproduciendo: reproduciendo > 0,
        pausado,
        silenciado: muted,
        genero: generoActual(),
        vozTts: vozParaMostrar(),
        motorVoz: motorVozActual(),
        motor: motorActual(),
        eco: ecoActual(),
        concurrencia: concurrenciaActual(),
      }
    }

    function publicar() {
      avisar?.(estadoActual())
    }

    /** Prende o apaga el aviso de síntesis sin publicar cambios que no cambian el estado visible. */
    function cambiarSintetizando(delta: number) {
      const antes = sintetizando > 0
      sintetizando = Math.max(0, sintetizando + delta)
      if ((sintetizando > 0) !== antes) publicar()
    }

    /** Igual que la síntesis, pero para reproducción: evita mostrar "Sintetizando..." sobre audio que ya suena. */
    function cambiarReproduciendo(delta: number) {
      const antes = reproduciendo > 0
      reproduciendo = Math.max(0, reproduciendo + delta)
      if ((reproduciendo > 0) !== antes) publicar()
    }

    function marcarHablando(
      valor: boolean,
      opts?: { escribirGlobal?: boolean; sessionID?: string; turno?: string },
    ) {
      const cambiaPausa = !valor && pausado
      if (hablando === valor && !cambiaPausa) return
      hablando = valor
      if (!valor) {
        pausado = false
        sesionHablando = undefined
      }
      if (!valor || opts?.escribirGlobal !== false) {
        guardarEstadoHablando(valor, {
          sessionID: opts?.sessionID ?? sesionHablando,
          ctrl: valor ? archivoCtrl : undefined,
          turno: opts?.turno ?? turnoActivo,
        })
      }
      publicar()
    }

    function alguienHablando(): boolean {
      if (hablando) return true
      return leerEstadoHablando()
    }

    function limpiarArchivosDeSesion(sessionID: string) {
      const mensajes = ultimosPorSesion.get(sessionID)
      if (!mensajes) return
      for (const mensaje of mensajes) {
        for (const archivo of mensaje.archivos) borrarSilencioso(archivo)
      }
      ultimosPorSesion.delete(sessionID)
      indiceAudioPorSesion.delete(sessionID)
      guardarCacheAudios()
    }

    function limpiarUltimosArchivos() {
      for (const mensajes of ultimosPorSesion.values()) {
        for (const mensaje of mensajes) {
          for (const archivo of mensaje.archivos) borrarSilencioso(archivo)
        }
      }
      ultimosPorSesion.clear()
      indiceAudioPorSesion.clear()
      guardarCacheAudios()
    }

    function asegurarEntradaSesion(sessionID: string, msgId: string): UltimoMensajeSesion {
      let mensajes = ultimosPorSesion.get(sessionID)
      if (!mensajes) {
        if (ultimosPorSesion.size >= MAX_SESIONES_AUDIO) {
          const masVieja = ultimosPorSesion.keys().next().value
          if (masVieja) limpiarArchivosDeSesion(masVieja)
        }
        mensajes = []
        ultimosPorSesion.set(sessionID, mensajes)
      }
      if (!mensajes.length || mensajes[mensajes.length - 1].msgId !== msgId) {
        mensajes.push({ msgId, archivos: [], texto: "" })
        if (mensajes.length > MAX_AUDIOS_POR_SESION) {
          const viejo = mensajes.shift()
          if (viejo) {
            for (const archivo of viejo.archivos) borrarSilencioso(archivo)
          }
        }
        // Los mensajes se guardan de viejo a nuevo: por defecto apuntamos al último.
        indiceAudioPorSesion.set(sessionID, mensajes.length - 1)
      }
      guardarCacheAudios()
      return mensajes[mensajes.length - 1]
    }

    function mensajeAudioActual(sessionID?: string): UltimoMensajeSesion | undefined {
      if (!sessionID) return undefined
      const mensajes = ultimosPorSesion.get(sessionID)
      if (!mensajes?.length) return undefined
      const indice = Math.max(0, Math.min(mensajes.length - 1, indiceAudioPorSesion.get(sessionID) ?? mensajes.length - 1))
      return mensajes[indice]
    }

    function pausarOReanudar() {
      if (!hablando) return
      if (!pausado) {
        pausado = true
        if (archivoCtrl) {
          try {
            writeFileSync(archivoCtrl, "pause")
          } catch {
            // ignora
          }
        }
        try {
          reproductorSay?.kill("SIGSTOP")
        } catch {
          // el proceso ya terminó
        }
      } else {
        pausado = false
        if (archivoCtrl) borrarSilencioso(archivoCtrl)
        try {
          reproductorSay?.kill("SIGCONT")
        } catch {
          // el proceso ya terminó
        }
        const resolver = esperarReanudar
        esperarReanudar = undefined
        resolver?.()
      }
      publicar()
    }

    function firstTimeFor(key: string): boolean {
      const now = Date.now()
      if (spoken.has(key)) return false

      for (const [oldKey, at] of spoken) if (now - at > 120_000) spoken.delete(oldKey)
      spoken.set(key, now)

      const lock = join(tmpdir(), `opencode-tts-seen-${key}.lock`)
      try {
        closeSync(openSync(lock, "wx"))
      } catch {
        return false
      }
      const timer = setTimeout(() => {
        try {
          rmSync(lock, { force: true })
        } catch {
          // ignora
        }
      }, 120_000)
      timer.unref?.()
      return true
    }

    function limpiarTimerTrabajando() {
      if (timerPrimerTrabajando) {
        clearTimeout(timerPrimerTrabajando)
        timerPrimerTrabajando = undefined
      }
      if (timerTrabajando) {
        clearTimeout(timerTrabajando)
        timerTrabajando = undefined
      }
    }

    function ecoUsuarioEnCurso(): boolean {
      if (leyendoEcoUsuario) return true
      return leerEstadoEco().activo
    }

    function proximoAvisoCompartidoEn(): number {
      const eco = leerEstadoEco()
      const desdeEco = eco.finEn > 0 ? eco.finEn + PAUSA_ENTRE_AVISOS_MS : 0
      return Math.max(proximoAvisoEn, desdeEco)
    }

    function marcarFinAudioPrevio(gen: number) {
      if (gen !== generation) return
      proximoAvisoEn = Date.now() + PAUSA_ENTRE_AVISOS_MS
    }

    function anunciarTrabajandoInicial() {
      if (muted || sesionActualApagada() || !ecoActual() || yaDijoTrabajando || esperandoPermiso || alguienHablando() || ecoUsuarioEnCurso()) return
      yaDijoTrabajando = true
      precalentar()
      decirTrabajando()
    }

    function programarPrimerTrabajando() {
      limpiarTimerTrabajando()
      if (!ejecutando || esperandoPermiso || muted || sesionActualApagada() || !ecoActual() || yaDijoTrabajando || leyendoAvisoHerramienta || alguienHablando()) {
        return
      }
      const gen = generation
      if (ecoUsuarioEnCurso()) {
        timerPrimerTrabajando = setTimeout(() => {
          timerPrimerTrabajando = undefined
          if (!ejecutando || esperandoPermiso || muted || sesionActualApagada() || !ecoActual() || gen !== generation) return
          programarPrimerTrabajando()
        }, 400)
        return
      }
      const eco = leerEstadoEco()
      const espera =
        eco.finEn > 0 && Date.now() - eco.finEn < RETRASO_PRIMER_TRABAJANDO_MS
          ? Math.max(200, eco.finEn + RETRASO_PRIMER_TRABAJANDO_MS - Date.now())
          : Math.max(RETRASO_PRIMER_TRABAJANDO_MS, proximoAvisoCompartidoEn() - Date.now())
      timerPrimerTrabajando = setTimeout(() => {
        timerPrimerTrabajando = undefined
        if (!ejecutando || esperandoPermiso || muted || sesionActualApagada() || !ecoActual() || gen !== generation) return
        if (ecoUsuarioEnCurso()) {
          programarPrimerTrabajando()
          return
        }
        if (leyendoAvisoHerramienta || alguienHablando()) return
        anunciarTrabajandoInicial()
        reprogramarTrabajando()
      }, espera)
    }

    function reprogramarTrabajando() {
      limpiarTimerTrabajando()
      if (!ejecutando || esperandoPermiso || muted || sesionActualApagada() || !ecoActual()) return
      const gen = generation
      timerTrabajando = setTimeout(() => {
        timerTrabajando = undefined
        if (!ejecutando || esperandoPermiso || muted || sesionActualApagada() || !ecoActual() || gen !== generation) return
        if (!alguienHablando() && !pausado) decirTrabajando()
        reprogramarTrabajando()
      }, INTERVALO_TRABAJANDO_MS)
    }

    function finalizarEjecucion() {
      ejecutando = false
      esperandoPermiso = false
      proximoAvisoEn = 0
      limpiarTimerTrabajando()
      limpiarHerramientasPendientes()
    }

    function limpiarHerramientasPendientes() {
      if (timerHerramientas) {
        clearTimeout(timerHerramientas)
        timerHerramientas = undefined
      }
      herramientasPendientes.clear()
    }

    function stopSpeaking(matarHuerfanos = true) {
      generation += 1
      pausado = false
      if (leyendoEcoUsuario) guardarEstadoEco(false, 0)
      leyendoEcoUsuario = false
      leyendoAvisoHerramienta = false
      proximoAvisoEn = 0
      limpiarHerramientasPendientes()
      limpiarTimerTrabajando()
      const habiaReproduccion = Boolean(archivoCtrl) || running.size > 0 || playerPendientes.size > 0
      if (archivoCtrl) {
        try {
          writeFileSync(archivoCtrl, "stop")
        } catch {
          // ignora
        }
        archivoCtrl = undefined
      }
      for (const [id, resolver] of edgePendientes) {
        try {
          edgeWorker?.stdin?.write(JSON.stringify({ cmd: "cancel", id }) + "\n")
        } catch {
          // ignora
        }
        resolver(false)
      }
      edgePendientes.clear()
      const resolver = esperarReanudar
      esperarReanudar = undefined
      resolver?.()

      for (const child of running) {
        // Si estaba pausado con SIGSTOP (caso say), necesita SIGCONT para atender SIGTERM.
        try {
          child.kill("SIGCONT")
        } catch {
          // ignora
        }
        try {
          child.kill("SIGTERM")
        } catch {
          // ignora
        }
      }
      running.clear()
      reproductorSay = undefined
      mensajeActual = undefined
      sesionHablando = undefined
      turnoActivo = undefined
      sesionEco = undefined
      turnoEco = undefined
      pendientes = 0
      enCola = false
      if (sintetizando > 0 || reproduciendo > 0) {
        sintetizando = 0
        reproduciendo = 0
        publicar()
      }
      bloques.clear()
      marcarHablando(false)

      // Si no tenía procesos propios registrados (por ejemplo tras una recarga),
      // corta cualquier audio huérfano del plugin.
      if (matarHuerfanos && !habiaReproduccion) {
        execFile("pkill", ["-f", TMP_PREFIX], () => {})
        if (motorVozActual() === "say") execFile("pkill", ["-x", "say"], () => {})
      }
    }

    /** Ejecuta un proceso; resuelve true solo si termina bien y no fue cancelado. */
    function run(
      command: string,
      args: string[],
      gen: number,
      stdin?: string,
      esSay = false,
      sessionID?: string,
      turno?: string,
    ): Promise<boolean> {
      return new Promise((resolve) => {
        if (gen !== generation) return resolve(false)
        if ((sessionID && sesionApagada(sessionID)) || perdioTurnoVoz(turno)) return resolve(false)

        const child = spawn(command, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"] })
        running.add(child)
        if (esSay) cambiarReproduciendo(1)
        // Solo la reproducción (say) saca de "En cola": sintetizar con edge-tts también pasa por run().
        if (esSay && enCola) {
          enCola = false
          publicar()
        }
        if (esSay) reproductorSay = child
        let vigilante: ReturnType<typeof setInterval> | undefined
        if (esSay && (sessionID || turno)) {
          vigilante = setInterval(() => {
            if (gen !== generation || (sessionID && sesionApagada(sessionID)) || perdioTurnoVoz(turno)) {
              try {
                child.kill("SIGCONT")
                child.kill("SIGTERM")
              } catch {
                // ignora
              }
            }
          }, 150)
        }
        let settled = false
        const done = (ok: boolean) => {
          if (settled) return
          settled = true
          if (esSay) cambiarReproduciendo(-1)
          if (vigilante) clearInterval(vigilante)
          running.delete(child)
          if (reproductorSay === child) reproductorSay = undefined
          resolve(ok && gen === generation && !perdioTurnoVoz(turno) && !(sessionID && sesionApagada(sessionID)))
        }

        child.on("error", () => done(false))
        child.on("close", (code) => done(code === 0))
        if (stdin !== undefined && child.stdin) child.stdin.end(stdin)
      })
    }

    async function esperarSiPausado(gen: number): Promise<boolean> {
      if (pausado && gen === generation) {
        await new Promise<void>((resolve) => {
          esperarReanudar = resolve
        })
      }
      return gen === generation
    }

    async function esperarTurnoLibre(
      gen: number,
      sessionID?: string,
      forzar = false,
      turno?: string,
    ): Promise<boolean> {
      if (concurrenciaActual() !== "esperar") return true
      if (otroHablando() && !enCola) {
        enCola = true
        publicar()
      }
      while (otroHablando()) {
        if (gen !== generation) return false
        // El dictado manda siempre: aunque venga de un mensaje "forzado", no puede hablar encima.
        if ((!forzar && (muted || (sessionID && sesionApagada(sessionID)))) || dictandoEnCurso()) return false
        if (perdioTurnoVoz(turno)) return false
        await new Promise<void>((r) => setTimeout(r, 150))
      }
      if (enCola) {
        enCola = false
        publicar()
      }
      return (
        gen === generation &&
        !dictandoEnCurso() &&
        !perdioTurnoVoz(turno) &&
        (forzar || !(sessionID && sesionApagada(sessionID)))
      )
    }

    async function playMp3(
      file: string,
      gen: number,
      sessionID?: string,
      turno?: string,
      forzar = false,
      alEmpezar?: () => void,
    ): Promise<boolean> {
      if (!(await esperarSiPausado(gen))) return false
      if ((!forzar && sessionID && sesionApagada(sessionID)) || perdioTurnoVoz(turno)) return false
      const ctrl = `${file}.ctrl`
      borrarSilencioso(ctrl)
      archivoCtrl = ctrl
      alEmpezar?.()
      cambiarReproduciendo(1)
      if (enCola) {
        enCola = false
        publicar()
      }
      if (sessionID) sesionHablando = sessionID
      guardarEstadoHablando(true, { sessionID: sessionID ?? sesionHablando, ctrl, turno })
      let vigilante: ReturnType<typeof setInterval> | undefined
      try {
        const worker = asegurarPlayerWorker()
        const id = nextReqId++
        const ok = await new Promise<boolean>((resolve) => {
          playerPendientes.set(id, resolve)
          if (sessionID || turno) {
            vigilante = setInterval(() => {
              if (
                gen !== generation ||
                dictandoEnCurso() ||
                (!forzar && sessionID && sesionApagada(sessionID)) ||
                perdioTurnoVoz(turno)
              ) {
                try {
                  writeFileSync(ctrl, "stop")
                } catch {
                  // ignora
                }
              }
            }, 150)
          }
          try {
            worker.stdin?.write(JSON.stringify({ id, file, ctrl }) + "\n")
          } catch {
            playerPendientes.delete(id)
            resolve(false)
          }
        })
        return ok && gen === generation && !perdioTurnoVoz(turno) && (forzar || !(sessionID && sesionApagada(sessionID)))
      } finally {
        cambiarReproduciendo(-1)
        if (vigilante) clearInterval(vigilante)
        if (archivoCtrl === ctrl) archivoCtrl = undefined
        borrarSilencioso(ctrl)
        if (!hablando) guardarEstadoHablando(false)
      }
    }

    async function sintetizarEdge(text: string, gen: number, voiceOverride?: string): Promise<string | undefined> {
      if (!EDGE_BIN || gen !== generation) return undefined
      const voice = voiceOverride ?? vozEdgeActual()
      const file = tmpFile()

      const worker = asegurarEdgeWorker()
      if (worker) {
        const id = nextReqId++
        const ok = await new Promise<boolean>((resolve) => {
          edgePendientes.set(id, resolve)
          try {
            worker.stdin?.write(JSON.stringify({ id, text, voice, rate: EDGE_RATE, out: file }) + "\n")
          } catch {
            edgePendientes.delete(id)
            resolve(false)
          }
        })
        if (ok && gen === generation && existsSync(file)) return file
        borrarSilencioso(file)
        if (gen !== generation) return undefined
      }

      // Respaldo: CLI directa de edge-tts si no se pudo usar el trabajador persistente.
      const args = ["--voice", voice]
      if (EDGE_RATE) args.push(`--rate=${EDGE_RATE}`)
      args.push("--text", text, "--write-media", file)

      const synthesized = await run(EDGE_BIN, args, gen)
      if (!synthesized || gen !== generation) {
        borrarSilencioso(file)
        return undefined
      }
      return file
    }

    async function speakSay(
      text: string,
      gen: number,
      voiceOverride?: string,
      sessionID?: string,
      turno?: string,
      alEmpezar?: () => void,
    ): Promise<boolean> {
      if (!(await esperarSiPausado(gen))) return false
      if (sessionID) sesionHablando = sessionID
      guardarEstadoHablando(true, { sessionID: sessionID ?? sesionHablando, turno })
      alEmpezar?.()
      const args = ["-v", voiceOverride ?? vozSayActual()]
      if (SAY_RATE) args.push("-r", SAY_RATE)
      try {
        return await run("say", args, gen, text, true, sessionID, turno)
      } finally {
        if (!hablando) guardarEstadoHablando(false)
      }
    }

    function encolarFragmento(text: string, sessionID?: string, forzar = false) {
      if (dictandoEnCurso() || ((muted || sesionApagada(sessionID ?? sesionActiva)) && !forzar)) return
      // En Linux no hay say ni AVFoundation: el texto se lee en la máquina del usuario.
      if (process.platform !== "darwin") avisarTextoParaLeer?.(text, sessionID)
      const gen = generation
      const turno = turnoActivo
      const guardarEnUltimo = Boolean(sessionID)
      pendientes += 1
      const esperarOtro = concurrenciaActual() === "esperar" && otroHablando()
      // "En cola" recién cuando algo está sonando: mientras se genera el MP3,
      // el pill muestra "Sintetizando..." (gestionado por cambiarSintetizando).
      if ((archivoCtrl || running.size > 0 || esperarOtro) && !enCola) {
        enCola = true
        publicar()
      }
      if (!esperarOtro && sessionID) sesionHablando = sessionID
      marcarHablando(true, { escribirGlobal: !esperarOtro, sessionID, turno })
      const entradaSesion = sessionID ? mensajeAudioActual(sessionID) : undefined
      if (entradaSesion) {
        entradaSesion.texto = entradaSesion.texto ? `${entradaSesion.texto} ${text}` : text
        guardarCacheAudios()
      }

      // Pre-genera el audio en paralelo mientras suena la oración anterior.
      const promesaArchivo = motorVozActual() === "edge" ? sintetizarEdge(text, gen) : undefined
      let sintesisContada = Boolean(promesaArchivo)
      if (sintesisContada) cambiarSintetizando(1)
      // Se libera recién cuando empieza a sonar (no cuando está listo el MP3),
      // para que el pill no pase a "Pausar voz" antes de tiempo.
      const liberarSintesis = () => {
        if (!sintesisContada) return
        sintesisContada = false
        cambiarSintetizando(-1)
      }

      queue = queue.then(async () => {
        let interrumpido = false
        const cortado = () =>
          gen !== generation ||
          perdioTurnoVoz(turno) ||
          ((!forzar && (muted || sesionApagada(sessionID))) || dictandoEnCurso())
        try {
          if (cortado()) {
            interrumpido = true
            if (promesaArchivo) {
              const sobrante = await promesaArchivo
              if (sobrante) borrarSilencioso(sobrante)
            }
            return
          }
          if (!(await esperarTurnoLibre(gen, sessionID, forzar, turno))) {
            interrumpido = true
            if (promesaArchivo) {
              const sobrante = await promesaArchivo
              if (sobrante) borrarSilencioso(sobrante)
            }
            return
          }
          if (promesaArchivo) {
            const archivo = await promesaArchivo
            if (cortado()) {
              interrumpido = true
              if (archivo) borrarSilencioso(archivo)
              return
            }
            if (archivo) {
              if (entradaSesion) {
                entradaSesion.archivos.push(archivo)
                guardarCacheAudios()
              }
              const ok = await playMp3(archivo, gen, sessionID, turno, forzar, liberarSintesis)
              if (!guardarEnUltimo) borrarSilencioso(archivo)
              if (cortado()) {
                interrumpido = true
                return
              }
              if (!ok && gen === generation) {
                await speakSay(text, gen, undefined, sessionID, turno, liberarSintesis)
                if (cortado()) interrumpido = true
              }
              return
            }
          }
          if (!cortado()) {
            await speakSay(text, gen, undefined, sessionID, turno, liberarSintesis)
            if (cortado()) interrumpido = true
          } else {
            interrumpido = true
          }
        } finally {
          liberarSintesis()
          if (gen === generation) {
            pendientes = Math.max(0, pendientes - 1)
            if (pendientes === 0) {
              enCola = false
              if (sintetizando > 0) {
                sintetizando = 0
                publicar()
              }
              marcarHablando(false)
              if (!interrumpido && !muted && !dictandoEnCurso() && !sesionApagada(sessionID ?? sesionActiva)) {
                reproducirEfecto(SONIDO_FIN_LECTURA)
                avisarLecturaTerminada?.(sessionID)
                notificarTurnoTerminadoSiListo()
              }
            }
          }
        }
      })
    }

    async function asegurarAudioAviso(frase: string): Promise<string | undefined> {
      if (motorVozActual() !== "edge" || !EDGE_BIN) return undefined
      const voice = vozEdgeActual()
      const clave = `${voice}::${frase}`
      const existente = cacheAvisos.get(clave)
      if (existente && existsSync(existente)) return existente

      const enCurso = avisosEnCurso.get(clave)
      if (enCurso) return enCurso

      const file = tmpFile()
      const tarea = (async () => {
        const worker = asegurarEdgeWorker()
        let ok = false
        if (worker) {
          const id = nextReqId++
          ok = await new Promise<boolean>((resolve) => {
            edgePendientes.set(id, resolve)
            try {
              worker.stdin?.write(JSON.stringify({ id, text: frase, voice, rate: EDGE_RATE, out: file }) + "\n")
            } catch {
              edgePendientes.delete(id)
              resolve(false)
            }
          })
        } else {
          const args = ["--voice", voice]
          if (EDGE_RATE) args.push(`--rate=${EDGE_RATE}`)
          args.push("--text", frase, "--write-media", file)
          ok = await run(EDGE_BIN, args, generation)
        }
        if (ok && existsSync(file)) {
          if (cacheAvisos.size >= 30) {
            const primera = cacheAvisos.keys().next().value
            if (primera) {
              const viejo = cacheAvisos.get(primera)
              if (viejo) borrarSilencioso(viejo)
              cacheAvisos.delete(primera)
            }
          }
          cacheAvisos.set(clave, file)
          return file
        }
        borrarSilencioso(file)
        return undefined
      })().finally(() => {
        if (avisosEnCurso.get(clave) === tarea) avisosEnCurso.delete(clave)
      })

      avisosEnCurso.set(clave, tarea)
      return tarea
    }

    function decirTrabajando() {
      if (muted || sesionActualApagada() || !ecoActual() || dictandoEnCurso() || alguienHablando() || pausado || !ejecutando || esperandoPermiso || trabajandoEnCola || ecoUsuarioEnCurso()) return
      if (!reclamarTurnoTrabajando()) return
      trabajandoEnCola = true
      const gen = generation
      if (motorVozActual() === "edge") {
        const clave = `${vozEdgeActual()}::Trabajando.`
        const cached = cacheAvisos.get(clave)
        const listo = cached && existsSync(cached) ? cached : undefined
        const promesa = listo ? Promise.resolve(listo) : asegurarAudioAviso("Trabajando.")
        queue = queue.then(async () => {
          let sono = false
          try {
            if (gen !== generation || muted || sesionActualApagada() || !ecoActual() || dictandoEnCurso() || alguienHablando() || pausado || !ejecutando || esperandoPermiso || ecoUsuarioEnCurso()) return
            const archivo = await promesa
            if (!archivo || gen !== generation || muted || sesionActualApagada() || !ecoActual() || dictandoEnCurso() || alguienHablando() || pausado || !ejecutando || esperandoPermiso || ecoUsuarioEnCurso()) return
            sono = true
            await playMp3(archivo, gen)
          } finally {
            trabajandoEnCola = false
            if (gen === generation) {
              if (sono) marcarFinAudioPrevio(gen)
              if (herramientasPendientes.size > 0) programarAvisoHerramientas()
            }
          }
        })
        return
      }
      queue = queue.then(async () => {
        let sono = false
        try {
          if (gen !== generation || muted || sesionActualApagada() || !ecoActual() || dictandoEnCurso() || alguienHablando() || pausado || !ejecutando || esperandoPermiso || ecoUsuarioEnCurso()) return
          sono = true
          await speakSay("Trabajando.", gen)
        } finally {
          trabajandoEnCola = false
          if (gen === generation) {
            if (sono) marcarFinAudioPrevio(gen)
            if (herramientasPendientes.size > 0) programarAvisoHerramientas()
          }
        }
      })
    }

    function decirAviso(frase: string, inclusoSiHablando = false, onFin?: (sono: boolean) => void) {
      if (muted || sesionActualApagada() || dictandoEnCurso() || pausado || (!inclusoSiHablando && alguienHablando())) {
        onFin?.(false)
        return
      }
      const gen = generation
      if (motorVozActual() === "edge") {
        const clave = `${vozEdgeActual()}::${frase}`
        const cached = cacheAvisos.get(clave)
        const listo = cached && existsSync(cached) ? cached : undefined
        const promesa = listo ? Promise.resolve(listo) : asegurarAudioAviso(frase)
        queue = queue.then(async () => {
          let sono = false
          try {
            if (gen !== generation || muted || sesionActualApagada() || dictandoEnCurso() || pausado || (!inclusoSiHablando && alguienHablando())) return
            const archivo = await promesa
            if (!archivo || gen !== generation || muted || sesionActualApagada() || dictandoEnCurso() || pausado || (!inclusoSiHablando && alguienHablando())) return
            sono = true
            await playMp3(archivo, gen)
          } finally {
            onFin?.(sono)
          }
        })
        return
      }
      queue = queue.then(async () => {
        let sono = false
        try {
          if (gen !== generation || muted || sesionActualApagada() || dictandoEnCurso() || pausado || (!inclusoSiHablando && alguienHablando())) return
          sono = true
          await speakSay(frase, gen)
        } finally {
          onFin?.(sono)
        }
      })
    }

    function decirEcoUsuario(texto: string, sessionID?: string) {
      const id = sessionID ?? sesionActiva
      if (muted || sesionApagada(id) || !ecoActual() || dictandoEnCurso()) return
      if (concurrenciaActual() === "cortar") {
        cortarAudioGlobal()
        turnoEco = reclamarTurnoVoz(id)
        turnoActivo = turnoEco
      }
      const gen = generation
      const turno = turnoEco
      const frase = `Tú: ${texto}`
      const generoEco: GeneroVoz = generoActual() === "masc" ? "fem" : "masc"
      const vozEcoEdge = generoEco === "masc" ? EDGE_VOICE_MASC : EDGE_VOICE_FEM
      const vozEcoSay = generoEco === "masc" ? SAY_VOICE_MASC : SAY_VOICE_FEM
      leyendoEcoUsuario = true
      sesionEco = id
      guardarEstadoEco(true)
      const promesaArchivo = motorVozActual() === "edge" ? sintetizarEdge(frase, gen, vozEcoEdge) : undefined

      queue = queue.then(async () => {
        let sono = false
        const cortado = () =>
          gen !== generation || muted || sesionApagada(id) || !ecoActual() || dictandoEnCurso() || perdioTurnoVoz(turno)
        try {
          if (cortado()) {
            if (promesaArchivo) {
              const sobrante = await promesaArchivo
              if (sobrante) borrarSilencioso(sobrante)
            }
            return
          }
          if (!(await esperarTurnoLibre(gen, id, false, turno))) {
            if (promesaArchivo) {
              const sobrante = await promesaArchivo
              if (sobrante) borrarSilencioso(sobrante)
            }
            return
          }
          if (promesaArchivo) {
            const archivo = await promesaArchivo
            if (cortado()) {
              if (archivo) borrarSilencioso(archivo)
              return
            }
            if (archivo) {
              sono = true
              const ok = await playMp3(archivo, gen, id, turno)
              borrarSilencioso(archivo)
              if (!ok && !cortado()) await speakSay(frase, gen, vozEcoSay, id, turno)
              return
            }
          }
          if (!cortado()) {
            sono = true
            await speakSay(frase, gen, vozEcoSay, id, turno)
          }
        } finally {
          guardarEstadoEco(false, sono && gen === generation ? Date.now() : 0)
          if (gen === generation) {
            leyendoEcoUsuario = false
            sesionEco = undefined
            if (sono) marcarFinAudioPrevio(gen)
            if (ejecutando && !esperandoPermiso && !muted && !yaDijoTrabajando && !alguienHablando() && !pausado) {
              programarPrimerTrabajando()
            }
            if (herramientasPendientes.size > 0) programarAvisoHerramientas()
          }
        }
      })
    }

    function programarAvisoHerramientas() {
      if (muted || sesionActualApagada() || !ecoActual() || alguienHablando() || pausado) return
      if (herramientasPendientes.size === 0) return
      if (leyendoAvisoHerramienta || trabajandoEnCola) return
      const gen = generation
      if (ecoUsuarioEnCurso()) {
        if (timerHerramientas) clearTimeout(timerHerramientas)
        timerHerramientas = setTimeout(() => {
          timerHerramientas = undefined
          if (gen !== generation || muted || sesionActualApagada() || !ecoActual() || alguienHablando() || pausado) {
            herramientasPendientes.clear()
            return
          }
          programarAvisoHerramientas()
        }, 400)
        return
      }
      const espera = Math.max(250, proximoAvisoCompartidoEn() - Date.now())
      if (timerHerramientas) clearTimeout(timerHerramientas)
      timerHerramientas = setTimeout(() => {
        timerHerramientas = undefined
        if (gen !== generation || muted || sesionActualApagada() || !ecoActual() || alguienHablando() || pausado) {
          herramientasPendientes.clear()
          return
        }
        if (ecoUsuarioEnCurso()) {
          programarAvisoHerramientas()
          return
        }
        if (leyendoAvisoHerramienta || trabajandoEnCola) return
        const frase = fraseHerramientas(herramientasPendientes)
        herramientasPendientes.clear()
        if (!frase) return
        leyendoAvisoHerramienta = true
        decirAviso(frase, false, (sono) => {
          if (gen !== generation) return
          leyendoAvisoHerramienta = false
          if (sono) marcarFinAudioPrevio(gen)
          if (herramientasPendientes.size > 0) programarAvisoHerramientas()
        })
      }, espera)
    }

    function registrarHerramienta(callId: string, toolName: string) {
      if (muted || sesionActualApagada() || !ecoActual()) return
      if (muted || herramientasVistas.has(callId)) return
      if (herramientasVistas.size > 200) herramientasVistas.clear()
      herramientasVistas.add(callId)

      const etiqueta = nombreHerramienta(toolName)
      herramientasPendientes.set(etiqueta, (herramientasPendientes.get(etiqueta) ?? 0) + 1)
      programarAvisoHerramientas()
    }

    function prepararMensaje(sessionID: string, msgId: string) {
      limpiarHerramientasPendientes()
      const previo = ultimosPorSesion.get(sessionID)
      if (previo?.[previo.length - 1]?.msgId === msgId) return
      const modo = concurrenciaActual()
      if (modo === "cortar") {
        const mismoEco = leyendoEcoUsuario && sesionEco === sessionID && Boolean(turnoEco)
        if (!mismoEco) {
          if (hablando || pausado) stopSpeaking(false)
          cortarAudioGlobal()
          turnoActivo = reclamarTurnoVoz(sessionID)
        } else {
          turnoActivo = turnoEco
        }
      } else {
        turnoActivo = undefined
      }
      asegurarEntradaSesion(sessionID, msgId)
      mensajeActual = msgId
    }

    function repetirUltimo(sessionID?: string, indice?: number) {
      if (hablando) return
      const id = sessionID || sesionActiva
      if (!id) return
      const mensajes = ultimosPorSesion.get(id)
      if (!mensajes?.length) return
      const destino = Math.max(
        0,
        Math.min(mensajes.length - 1, indice ?? indiceAudioPorSesion.get(id) ?? mensajes.length - 1),
      )
      indiceAudioPorSesion.set(id, destino)
      guardarCacheAudios()
      const entrada = mensajes[destino]
      sesionActiva = id
      if (concurrenciaActual() === "cortar") {
        cortarAudioGlobal()
        turnoActivo = reclamarTurnoVoz(id)
      } else {
        turnoActivo = undefined
      }
      const turno = turnoActivo
      const archivos = entrada.archivos.filter((archivo) => existsSync(archivo))
      if (archivos.length > 0) {
        const gen = generation
        pendientes += archivos.length
        const esperarOtro = concurrenciaActual() === "esperar" && otroHablando()
        if ((archivoCtrl || running.size > 0 || esperarOtro) && !enCola) {
          enCola = true
          publicar()
        }
        if (!esperarOtro) sesionHablando = id
        marcarHablando(true, { escribirGlobal: !esperarOtro, sessionID: id, turno })
        for (const archivo of archivos) {
          queue = queue.then(async () => {
            try {
              if (gen !== generation || perdioTurnoVoz(turno) || dictandoEnCurso()) return
              if (!(await esperarTurnoLibre(gen, id, true, turno))) return
              const ok = await playMp3(archivo, gen, id, turno, true)
              // Si el MP3 quedó viejo o el reproductor falla tras recargar, se sintetiza el texto.
              if (!ok && gen === generation && entrada.texto && !dictandoEnCurso()) {
                const texto = entrada.texto
                entrada.texto = ""
                encolarFragmento(texto, id, true)
              }
            } finally {
              if (gen === generation) {
                pendientes = Math.max(0, pendientes - 1)
                if (pendientes === 0) {
                  enCola = false
                  if (sintetizando > 0) {
                    sintetizando = 0
                    publicar()
                  }
                  marcarHablando(false)
                }
              }
            }
          })
        }
        return
      }
      if (entrada.texto) encolarFragmento(entrada.texto, id, true)
    }

    try {
      const registro = await ctx.rpc.register(Voz, {
        pausar: async () => {
          pausarOReanudar()
          return estadoActual()
        },
        repetir: async (input) => {
          const { sessionID } = (input ?? {}) as { sessionID?: string }
          repetirUltimo(sessionID)
          return estadoActual()
        },
        parar: async () => {
          cancelarAutoEscucha()
          cortarAudioGlobal()
          stopSpeaking()
          return estadoActual()
        },
        estado: async () => estadoActual(),
        alternar: async () => {
          muted = !muted
          await ctx.storage.set("muted", muted)
          if (muted) {
            cancelarAutoEscucha()
            cortarAudioGlobal()
            stopSpeaking()
          } else {
            reprogramarTrabajando()
          }
          publicar()
          return estadoActual()
        },
        cambiarGenero: async () => {
          genero = generoActual() === "fem" ? "masc" : "fem"
          guardarEstadoGenero(genero)
          await ctx.storage.set("genero", genero)
          await ctx.storage.set("voice", vozEdgeActual())
          if (motorVozActual() === "edge") {
            void asegurarAudioAviso("Trabajando.")
            void asegurarAudioAviso("Permiso pendiente.")
          }
          publicar()
          return estadoActual()
        },
        cambiarMotorVoz: async () => {
          const siguiente = motorVozActual() === "edge" ? "say" : "edge"
          if (siguiente === "edge" && !EDGE_BIN) return estadoActual()
          ENGINE = siguiente
          guardarEstadoMotorVoz(siguiente)
          await ctx.storage.set("motorVoz", siguiente)
          stopSpeaking()
          if (siguiente === "edge") precalentar()
          publicar()
          return estadoActual()
        },
        cambiarMotor: async () => {
          const orden: MotorStt[] = ["auto", "elevenlabs", "groq"]
          motor = orden[(orden.indexOf(motorActual()) + 1) % orden.length] ?? "auto"
          guardarEstadoMotor(motor)
          await ctx.storage.set("motor", motor)
          publicar()
          return estadoActual()
        },
        alternarEco: async () => {
          ecoActivo = !ecoActual()
          guardarEstadoEcoActivo(ecoActivo)
          await ctx.storage.set("eco", ecoActivo)
          if (!ecoActivo) {
            limpiarTimerTrabajando()
            limpiarHerramientasPendientes()
          }
          publicar()
          return estadoActual()
        },
        alternarConcurrencia: async () => {
          concurrencia = concurrenciaActual() === "cortar" ? "esperar" : "cortar"
          guardarEstadoConcurrencia(concurrencia)
          await ctx.storage.set("concurrencia", concurrencia)
          publicar()
          return estadoActual()
        },
        alternarApagado: async (input) => {
          const { sessionID } = input as { sessionID: string }
          const apagada = await alternarApagadoSesion(sessionID)
          return { apagada }
        },
        estadoSesion: async (input) => {
          const { sessionID } = input as { sessionID: string }
          return { apagada: sesionApagada(sessionID) }
        },
        tieneVoz: async (input) => {
          const { sessionID } = (input ?? {}) as { sessionID?: string }
          const id = sessionID || sesionActiva
          const entrada = mensajeAudioActual(id)
          const archivos = entrada?.archivos.filter((archivo) => existsSync(archivo)) ?? []
          return {
            tiene: Boolean(entrada && (archivos.length > 0 || (entrada.texto ?? "").trim().length > 0)),
          }
        },
        estadoAudios: async (input) => {
          const { sessionID } = (input ?? {}) as { sessionID?: string }
          const id = sessionID || sesionActiva
          const total = id ? (ultimosPorSesion.get(id)?.length ?? 0) : 0
          const actual = total
            ? Math.max(0, Math.min(total - 1, id ? (indiceAudioPorSesion.get(id) ?? total - 1) : total - 1)) + 1
            : 0
          return { actual, total }
        },
        moverAudio: async (input) => {
          const { sessionID, direccion } = (input ?? {}) as { sessionID?: string; direccion?: number }
          const id = sessionID || sesionActiva
          const mensajes = id ? ultimosPorSesion.get(id) : undefined
          if (!id || !mensajes?.length) return estadoActual()
          const actual = indiceAudioPorSesion.get(id) ?? mensajes.length - 1
          const destino = Math.max(0, Math.min(mensajes.length - 1, actual + (direccion ?? 0)))
          if (hablando || pausado) stopSpeaking()
          repetirUltimo(id, destino)
          return estadoActual()
        },
        marcarDictado: async () => {
          const hasta = Date.now() + 10_000
          proximoMensajeDictadoHasta = hasta
          guardarEstadoDictado(hasta)
          return estadoActual()
        },
        transcribir: async (input) => {
          const { audioBase64, mimeType } = input as { audioBase64: string; mimeType: string }
          guardarAudioDictado(audioBase64, mimeType)
          return transcribirAudio(audioBase64, mimeType, motorActual())
        },
        sonidoEnvio: async () => {
          reproducirEfecto(SONIDO_ENVIO)
          return {}
        },
        sonidoInicioDictado: async () => {
          await reproducirEfectoYEsperar(SONIDO_INICIO_DICTADO)
          return {}
        },
        sonidoFinGrabacion: async () => {
          reproducirEfecto(SONIDO_FIN_GRABACION)
          return {}
        },
        sonidoCorteTramo: async () => {
          await reproducirEfectoYEsperar(SONIDO_CORTE_TRAMO)
          return {}
        },
        sonidoSinVoz: async () => {
          reproducirEfecto(SONIDO_SIN_VOZ)
          return {}
        },
        agregarVocabulario: async (input) => {
          const { termino } = input as { termino: string }
          return agregarAlVocabulario(termino)
        },
        listarVocabulario: async () => {
          return { terminos: cargarVocabulario(), ruta: rutaVocabulario() }
        },
        logDiagnostico: async (input) => {
          registrarLogRemoto(((input as { mensaje?: string })?.mensaje ?? "").slice(0, 300))
          return {}
        },
        leerTexto: async (input) => {
          const { texto, sessionID, msgId } = (input ?? {}) as {
            texto?: string
            sessionID?: string
            msgId?: string
          }
          const limpio = texto?.trim() ?? ""
          if (limpio && dictandoEnCurso()) {
            registrarLogRemoto(`leerTexto BLOQUEADO por dictado sesion=${sessionID ?? "-"}`)
          }
          if (limpio && !muted && !sesionActualApagada() && !dictandoEnCurso()) {
            if (sessionID) asegurarEntradaSesion(sessionID, msgId || `remoto-${Date.now()}`)
            const info = leerEstadoHablandoInfo()
            const cortar =
              concurrenciaActual() === "cortar" &&
              info.activo &&
              (!info.sessionID || info.sessionID !== sessionID)
            registrarLogRemoto(
              `leerTexto sesion=${sessionID ?? "-"} global=${info.activo} globalSesion=${info.sessionID ?? "-"} local=${sesionHablando ?? "-"} cortar=${cortar}`,
            )
            if (cortar) {
              cortarAudioGlobal()
              stopSpeaking(false)
            }
            encolarFragmento(limpio, sessionID, true)
          }
          return estadoActual()
        },
        estadoDictado: async (input) => {
          const { activo } = input as { activo: boolean }
          guardarEstadoDictando(activo)
          registrarLogRemoto(
            `estadoDictado activo=${activo} instancia=${INSTANCIA_ID} flag=${dictandoEnCurso()} hablando=${hablando}`,
          )
          if (activo) {
            cancelarAutoEscucha()
            cortarAudioGlobal()
            stopSpeaking()
          }
          return estadoActual()
        },
      })
      avisar = (estado) => {
        void registro.events.emit("estado", estado)
      }
      avisarLecturaTerminada = (sessionID?: string) => {
        void registro.events.emit("lecturaTerminada", sessionID ? { sessionID } : {})
      }
      avisarTurnoTerminado = (sessionID?: string) => {
        void registro.events.emit("turnoTerminado", sessionID ? { sessionID } : {})
      }
      avisarTextoParaLeer = (texto, sessionID) => {
        void registro.events.emit("textoParaLeer", sessionID ? { texto, sessionID } : { texto })
      }
    } catch (error) {
      console.error("voz: no se pudo registrar el puente con la parte gráfica", error)
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.text.delta",
            "session.text.ended",
            "session.inbox.enqueued",
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.idle",
            "session.tool.input.started",
            "permission.asked",
            "permission.replied",
          ],
          signal: controller.signal,
        })) {
          if (event.location?.directory && event.location.directory !== ctx.location.directory) continue

          const sesionEvento = (event.data as { sessionID?: string } | undefined)?.sessionID
          if (sesionApagada(sesionEvento)) continue
          if (sesionEvento) sesionActiva = sesionEvento

          if (event.type === "session.inbox.enqueued") {
            if (event.data.item?.type === "user") {
              const ejecucionRecienIniciada = Boolean(timerPrimerTrabajando)
              yaDijoTrabajando = false
              limpiarEstadoTrabajando()
              const hastaDictado = Math.max(proximoMensajeDictadoHasta, leerEstadoDictadoHasta())
              turnoFueDictado = Date.now() <= hastaDictado
              proximoMensajeDictadoHasta = 0
              if (turnoFueDictado && hastaDictado > 0) {
                const marca = hastaDictado
                const t = setTimeout(() => {
                  if (leerEstadoDictadoHasta() === marca) guardarEstadoDictado(0)
                }, 1500)
                t.unref?.()
              }
              respondioEnEsteTurno = false
              sesionRespuesta = undefined
              finalizarEjecucion()
              if (concurrenciaActual() === "cortar") {
                cortarAudioGlobal()
                stopSpeaking(false)
              } else if (sesionHablando === sesionEvento) {
                stopSpeaking(false)
              }
              if (!muted) {
                precalentar()
                if (firstTimeFor(`inbox-${event.data.inboxID}`)) {
                  const textoUsuario = limpiarMensajeUsuario(event.data.item.payload.text)
                  if (textoUsuario.length > 0) decirEcoUsuario(textoUsuario, sesionEvento)
                }
                if (ejecucionRecienIniciada) {
                  ejecutando = true
                  programarPrimerTrabajando()
                }
              } else if (ejecucionRecienIniciada) {
                ejecutando = true
              }
            }
            continue
          }

          if (event.type === "session.execution.started") {
            ejecutando = true
            esperandoPermiso = false
            if (!muted && firstTimeFor(`exec-${event.id}`)) {
              precalentar()
              if (yaDijoTrabajando) {
                reprogramarTrabajando()
              } else {
                programarPrimerTrabajando()
              }
            }
            continue
          }

          if (event.type === "session.execution.succeeded" || event.type === "session.idle") {
            finalizarEjecucion()
            notificarTurnoTerminadoSiListo()
            continue
          }

          if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
            cancelarAutoEscucha()
            finalizarEjecucion()
            continue
          }

          if (event.type === "permission.asked") {
            esperandoPermiso = true
            limpiarTimerTrabajando()
            if (!muted && firstTimeFor(`perm-${event.id}`)) {
              precalentar()
              decirAviso("Permiso pendiente.", true)
            }
            continue
          }

          if (event.type === "permission.replied") {
            esperandoPermiso = false
            if (!muted && firstTimeFor(`perm-reply-${event.id}`)) {
              const frase = FRASES_PERMISO_RESPUESTA[event.data.reply]
              if (frase) decirAviso(frase, true)
            }
            reprogramarTrabajando()
            continue
          }

          if (event.type === "session.tool.input.started") {
            registrarHerramienta(event.data.id, event.data.name)
            reprogramarTrabajando()
            continue
          }

          if (event.type === "session.text.delta") {
            respondioEnEsteTurno = true
            sesionRespuesta = event.data.sessionID
            reprogramarTrabajando()
            if (muted) continue
            const data = event.data
            const key = `${data.sessionID}-${data.assistantMessageID}-${data.ordinal}`
            let bloque = bloques.get(key)
            if (!bloque) {
              if (!firstTimeFor(key)) continue
              prepararMensaje(data.sessionID, data.assistantMessageID)
              bloque = { pendiente: "", enCodigo: false, emitidos: 0, charsEnviados: 0 }
              bloques.set(key, bloque)
            }
            for (const oracion of extraerOraciones(bloque, data.delta)) {
              encolarFragmento(oracion, data.sessionID)
            }
            continue
          }

          // session.text.ended
          respondioEnEsteTurno = true
          sesionRespuesta = event.data.sessionID
          reprogramarTrabajando()
          const data = event.data
          const key = `${data.sessionID}-${data.assistantMessageID}-${data.ordinal}`
          const bloque = bloques.get(key)
          if (bloque) {
            bloques.delete(key)
            if (!muted) {
              const resto = vaciarBloque(bloque)
              if (resto) encolarFragmento(resto, data.sessionID)
            }
            continue
          }

          if (muted) continue
          if (!firstTimeFor(key)) continue
          const text = clean(data.text)
          if (text.length > 1) {
            prepararMensaje(data.sessionID, data.assistantMessageID)
            encolarFragmento(text, data.sessionID)
          }
        }
      } catch {
        // el stream se aborta al descargar el plugin
      }
    })()

    return () => {
      controller.abort()
      avisar = undefined
      avisarLecturaTerminada = undefined
      avisarTurnoTerminado = undefined
      avisarTextoParaLeer = undefined
      cancelarAutoEscucha()
      finalizarEjecucion()
      stopSpeaking()
      cerrarTrabajadores()
      limpiarUltimosArchivos()
      for (const archivo of cacheAvisos.values()) borrarSilencioso(archivo)
      cacheAvisos.clear()
    }
  },
})
